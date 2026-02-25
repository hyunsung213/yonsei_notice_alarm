import axios from "axios";
import * as cheerio from "cheerio";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// --- 설정 및 경로 ---
const TARGET_URL = "https://mirae.yonsei.ac.kr/wj/1415/subview.do";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DB_PATH = path.join(__dirname, "../config/lastId.json");
const USER_PROFILE_PATH = path.join(__dirname, "../config/userProfile.json");

// Gemini API 초기화 (최신 Gemini 3 혹은 2.5 Flash 권장)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface Notice {
  id: string;
  title: string;
  link: string;
  info: { date: string };
  importance?: number;
  summary?: string;
}

// 1. 유저 나이 계산 함수 (한국나이, 만 나이)
function calculateAge(birthYear: number) {
  const currentYear = new Date().getFullYear();
  const koreanAge = currentYear - birthYear + 1;
  const internationalAge = currentYear - birthYear;
  return { koreanAge, internationalAge };
}

// 2. 공지 상세 본문 크롤링 함수
async function getNoticeContent(url: string): Promise<string> {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    // 연세대학교 미래캠퍼스 상세 페이지 본문 영역 (.viewCont .txt)
    const content = $(".viewCont .txt").text().replace(/\s\s+/g, " ").trim();
    return content.substring(0, 2000); // 토큰 절약을 위해 2000자 제한
  } catch (error) {
    console.error(`본문 크롤링 실패: ${url}`);
    return "본문 내용을 불러올 수 없습니다.";
  }
}

// 3. LLM 분석 함수 (중요도 및 개인 맞춤 요약)
async function analyzeNoticeWithLLM(notice: Notice, userProfile: any) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const detailContent = await getNoticeContent(notice.link);
  const { koreanAge, internationalAge } = calculateAge(userProfile.birthYear);

  const prompt = `
    당신은 대학생을 위한 스마트 공지 알림봇입니다.
    유저의 프로필과 공지사항 상세 내용을 대조하여 중요도를 판단하고 핵심을 요약하세요.

    [유저 프로필]
    - 나이: ${userProfile.birthYear}년생 (한국나이 ${koreanAge}세, 만 ${internationalAge}세)
    - 학력: ${userProfile.grade}학년 ${userProfile.isFreshman ? "(신입생)" : ""}
    - 전공: ${userProfile.department}
    - 관심사: ${userProfile.interests.join(", ")}
    - 졸업 예정 여부: ${userProfile.isCandidateForGraduation}

    [공지사항]
    - 제목: ${notice.title}
    - 본문: ${detailContent}

    [수행 과제 (엄격하게 평가할 것)]
    1. 중요도 (1~5점):
       - 5점: 유저의 전공 직결, 신입생 필수 공지, 혹은 유저 나이/학년에서만 가능한 마지막 기회.
       - 4점: 관심사 관련 공지, 수혜 대상에 포함되는 장학금/대외활동.
       - 3점: 전교생 공통 유용한 정보.
       - 2점: 유저와 무관한 학년/전공 대상이거나 단순 참고용.
       - 1점: 유저가 지원 자격(만 나이 초과, 학년 불일치 등)에서 완전히 배제된 공지.
    
    2. 자격 검증: 
       - 본문의 '만 나이' 제한과 유저의 만 ${internationalAge}세를 대조하세요.
       - 본문의 '학년' 제한과 유저의 ${userProfile.grade}학년을 대조하세요. 자격 미달 시 중요도를 2점 이하로 낮추세요.

    3. 요약 (summary): 
       - 중요도 3점 이상인 경우에만 작성. 제목을 반복하지 말고 "왜 유저에게 필요한지"를 한 문장으로 설명하세요.

    JSON으로만 응답: { "importance": 4, "summary": "내용" }
  `;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response
      .text()
      .replace(/```json|```/g, "")
      .trim();
    return JSON.parse(text);
  } catch (error) {
    console.error("LLM 분석 실패:", error);
    return { importance: 2, summary: "내용 분석 중 오류가 발생했습니다." };
  }
}

// 4. 목록 수집 및 업데이트 체크
async function getLatestNotices(lastSavedId: string): Promise<Notice[]> {
  try {
    const { data } = await axios.get(TARGET_URL);
    const $ = cheerio.load(data);
    const notices: Notice[] = [];

    $(".boardWrap > ul > li").each((_, el) => {
      const $el = $(el);
      if ($el.hasClass("board-noti")) return; // 고정 공지 제외

      const id = $el.find(".num span").text().trim();
      if (id && Number(id) > Number(lastSavedId)) {
        const title = $el.find(".title strong").text().trim();
        const link = `https://mirae.yonsei.ac.kr${$el.find("a").attr("href")}?layout=unknown`;
        const date = $el
          .find(".date-area")
          .first()
          .text()
          .replace("작성일", "")
          .trim();
        notices.push({ id, title, link, info: { date } });
      }
    });
    return notices.reverse(); // 오래된 순으로 정렬
  } catch (error) {
    console.error("공지 목록 수집 실패:", error);
    return [];
  }
}

// 5. 디스코드 알림 전송
async function sendDiscordNotification(notice: Notice) {
  const colorMap: { [key: number]: number } = {
    5: 0xff0000,
    4: 0xffa500,
    3: 0x003399,
    2: 0x808080,
    1: 0xeeeeee,
  };

  const payload = {
    embeds: [
      {
        title: `${"⭐".repeat(notice.importance || 1)} ${notice.title}`,
        description:
          notice.importance && notice.importance >= 3
            ? `**🤖 AI 비서 요약:**\n${notice.summary}\n\n[📄 상세 본문 확인하기](${notice.link})`
            : `중요도가 낮은 공지입니다. 내용을 확인하려면 아래 링크를 클릭하세요.\n\n[📄 상세 보기](${notice.link})`,
        color: colorMap[notice.importance || 3],
        fields: [
          {
            name: "📊 분석 중요도",
            value: `Level ${notice.importance}/5`,
            inline: true,
          },
          { name: "📅 등록일", value: `\`${notice.info.date}\``, inline: true },
        ],
        footer: { text: "Yonsei Mirae Smart Bot" },
        timestamp: new Date(),
      },
    ],
  };

  await axios.post(DISCORD_WEBHOOK_URL!, payload);
}

// --- 메인 실행 함수 ---
async function main() {
  console.log("🚀 스마트 공지 알림이 가동 시작...");

  if (!fs.existsSync(USER_PROFILE_PATH)) {
    console.error("❌ 유저 프로필 파일이 없습니다.");
    return;
  }

  const userProfile = JSON.parse(fs.readFileSync(USER_PROFILE_PATH, "utf-8"));
  const dbContent = fs.existsSync(DB_PATH)
    ? JSON.parse(fs.readFileSync(DB_PATH, "utf-8"))
    : { Notice: { id: "0" } };
  const lastSavedNotice = dbContent.Notice;

  const newNotices = await getLatestNotices(lastSavedNotice.id);

  if (newNotices.length === 0) {
    console.log("☕ 새로운 공지가 없습니다.");
    return;
  }

  for (const notice of newNotices) {
    console.log(`🔍 분석 중: ${notice.title}`);

    // LLM 분석 (본문 크롤링 포함)
    const analysis = await analyzeNoticeWithLLM(notice, userProfile);
    notice.importance = analysis.importance;
    notice.summary = analysis.summary;

    // 중요도가 1점(전혀 무관)인 공지는 알림을 생략하거나 로그만 남김
    if (notice.importance && notice.importance <= 1) {
      console.log(`⏩ 스킵: 유저와 무관한 공지로 판단됨 (ID: ${notice.id})`);
    } else {
      await sendDiscordNotification(notice);
      console.log(`✅ 알림 전송 완료: ${notice.id}`);
    }

    await sleep(3000); // 봇 차단 방지 대기
  }

  // 마지막 공지 ID 업데이트
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify({ Notice: newNotices[newNotices.length - 1] }, null, 2),
  );
  console.log("🏁 모든 작업이 완료되었습니다.");
}

main();
