import axios from "axios";
import * as cheerio from "cheerio";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// --- 설정 및 초기화 ---
const TARGET_URL = "https://mirae.yonsei.ac.kr/wj/1415/subview.do";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DB_PATH = path.join(__dirname, "../config/lastId.json");
const USER_PROFILE_PATH = path.join(__dirname, "../config/userProfile.json");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface Notice {
  id: string;
  title: string;
  link: string;
  info: { date: string };
  importance?: number; // 1~5
  summary?: string; // 요약 내용
}

// 1. 유저 정보 읽기
function getUserProfile() {
  if (fs.existsSync(USER_PROFILE_PATH)) {
    return JSON.parse(fs.readFileSync(USER_PROFILE_PATH, "utf-8"));
  }
  return null;
}

// 2. LLM을 활용한 중요도 판단 및 요약
async function analyzeNoticeWithLLM(notice: Notice, userProfile: any) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `
    당신은 대학생을 위한 스마트 공지 알우미입니다. 
    다음 유저 정보와 공지사항 제목을 바탕으로 2가지를 수행하세요.

    [유저 정보]
    - 학년: ${userProfile.grade}학년 ${userProfile.isFreshman ? "(신입생)" : ""}
    - 전공: ${userProfile.department}
    - 관심사: ${userProfile.interests.join(", ")}
    - 졸업 예정 여부: ${userProfile.isCandidateForGraduation}

    [공지사항 제목]
    "${notice.title}"

    [수행 과제]
    1. 중요도 판단: 이 유저에게 이 공지가 얼마나 중요한지 1~5점으로 평가하세요.
       - 예: 신입생인데 '신입생 OT'라면 5점, 졸업 관련인데 저학년이면 1점.
    2. 요약: 중요도가 3점 이상인 경우에만, 이 공지가 왜 중요한지 또는 어떤 내용일지 한 문장으로 추측/요약하세요. (3점 미만이면 "생략"이라고 답하세요)

    [응답 형식]
    JSON 형식으로만 답하세요:
    { "importance": 4, "summary": "내용 요약" }
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response
      .text()
      .replace(/```json|```/g, "")
      .trim();
    return JSON.parse(text);
  } catch (error) {
    console.error("LLM 분석 실패:", error);
    return { importance: 3, summary: "분석 실패 (기본 중요도 적용)" };
  }
}

// 3. 기존 getLatestNotices 수정 (데이터 수집 로직 유지)
async function getLatestNotices(lastSavedId: string): Promise<Notice[]> {
  try {
    const { data } = await axios.get(TARGET_URL);
    const $ = cheerio.load(data);
    const notices: Notice[] = [];

    $(".boardWrap > ul > li").each((_, el) => {
      const $el = $(el);
      if ($el.hasClass("board-noti")) return;

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
    return notices.reverse(); // 오래된 글부터 알림을 보내기 위해 반전
  } catch (error) {
    console.error("데이터 수집 중 오류:", error);
    return [];
  }
}

// 4. 디스코드 전송 (요약 및 중요도 포함)
async function sendDiscordNotification(notice: Notice) {
  const colorMap: { [key: number]: number } = {
    5: 0xff0000, // 빨강
    4: 0xffa500, // 주황
    3: 0x003399, // 연세 블루
    2: 0x808080, // 회색
    1: 0xeeeeee, // 연회색
  };

  const payload = {
    embeds: [
      {
        title: `${"⭐".repeat(notice.importance || 1)} ${notice.title}`,
        description:
          notice.summary && notice.summary !== "생략"
            ? `**🤖 AI 요약:** ${notice.summary}\n\n[📄 상세 보기](${notice.link})`
            : `새로운 공지가 등록되었습니다.\n\n[📄 상세 보기](${notice.link})`,
        color: colorMap[notice.importance || 3],
        fields: [
          {
            name: "📊 중요도",
            value: `Level ${notice.importance}/5`,
            inline: true,
          },
          { name: "📅 작성일", value: `\`${notice.info.date}\``, inline: true },
        ],
        footer: { text: "Yonsei Mirae Smart Bot" },
        timestamp: new Date(),
      },
    ],
  };

  await axios.post(DISCORD_WEBHOOK_URL!, payload);
}

// --- 메인 실행 로직 ---
async function main() {
  const userProfile = getUserProfile();
  const lastSavedNotice = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"))
    .Notice || { id: "0" };

  const newNotices = await getLatestNotices(lastSavedNotice.id);

  if (newNotices.length > 0) {
    for (const notice of newNotices) {
      // 중요도 및 요약 추가
      const analysis = await analyzeNoticeWithLLM(notice, userProfile);
      notice.importance = analysis.importance;
      notice.summary = analysis.summary;

      await sendDiscordNotification(notice);
      await sleep(2000);
    }
    // 가장 최신 공지로 업데이트
    fs.writeFileSync(
      DB_PATH,
      JSON.stringify({ Notice: newNotices[newNotices.length - 1] }, null, 2),
    );
  }
}

main();
