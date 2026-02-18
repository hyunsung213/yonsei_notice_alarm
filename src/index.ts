import axios from "axios";
import * as cheerio from "cheerio";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

// 1. 설정 정보
const TARGET_URL = "https://mirae.yonsei.ac.kr/wj/1415/subview.do";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DB_PATH = path.join(__dirname, "../config/lastId.json");
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// 공지사항 데이터 타입 정의
interface Notice {
  id: string;
  title: string;
  link: string;
  info: Info;
}

interface Info {
  typeCL: string;
  date: string;
  dateLast: string;
}

// 1. 저장된 마지막 ID 읽기
function getLastNotice(): Notice | null {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, "utf-8");
      const parsed = JSON.parse(data);

      // 파일 안에 Notice라는 키가 있는지 확인하고 반환
      return parsed.Notice || null;
    }
  } catch (error) {
    console.error("파일 읽기 중 오류 발생:", error);
  }
  return null;
}

// 2. 새로운 ID 저장하기
function saveLastId(notice: Notice) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ Notice: notice }, null, 2));
}

async function getLatestNotices(lastSavedId: string): Promise<Notice[] | null> {
  try {
    // 사이트 HTML 가져오기
    const { data } = await axios.get(TARGET_URL);
    const $ = cheerio.load(data);
    const notices: Notice[] = [];

    // boardWrap 내의 li를 돌며 '고정 공지'가 아닌 '일반 게시글' 중 가장 첫 번째 것을 찾습니다.
    $(".boardWrap > ul > li").each((_, el) => {
      const $el = $(el);

      // 'board-noti' 클래스가 있으면 상단 고정 공지이므로 제외 (취향에 따라 포함 가능)
      if ($el.hasClass("board-noti")) return;

      const id = $el.find(".num span").text().trim();

      if (id && Number(id) > Number(lastSavedId)) {
        const title = $el.find(".title strong").text().trim();
        const relativeLink = $el.find("a").attr("href");
        const link = `https://mirae.yonsei.ac.kr${relativeLink}?layout=unknown`;
        const typeCL = $el.find(".typeCL").text().trim();
        const date = $el
          .find(".date-area")
          .first()
          .text()
          .replace("작성일", "")
          .trim();
        const dateLast = $el
          .find(".date-area last")
          .first()
          .text()
          .replace("기간", "")
          .trim();

        if (id && title) {
          notices.push({ id, title, link, info: { typeCL, date, dateLast } });
        }
      } else {
        // ID가 lastSavedId보다 작거나 같으면 더 이상 새로운 공지가 없으므로 반복 종료
        return null;
      }
    });

    return notices.length > 0 ? notices : [];
  } catch (error) {
    console.error("데이터를 가져오는 중 오류 발생:", error);
    return null;
  }
}

async function sendDiscordNotification(notice: Notice) {
  const LIST_URL = "https://mirae.yonsei.ac.kr/wj/1415/subview.do";

  const payload = {
    embeds: [
      {
        title: "📢 연세대학교 미래캠퍼스 새 공지사항",
        // 공지 제목을 강조하고 클릭 시 바로 상세 페이지로 이동하게 함
        description: `### [${notice.title}](${notice.link})\n\n새로운 학사 공지가 등록되었습니다. 아래 정보를 확인하세요.`,
        color: 0x003399, // 연세 블루
        fields: [
          {
            name: "📅 작성일",
            value: `\`${notice.info.date}\``,
            inline: true,
          },
          {
            name: "🆔 글 번호",
            value: `\`${notice.id}\``,
            inline: true,
          },
          {
            name: "🔗 바로가기",
            // 상세 페이지와 전체 목록 링크를 한 영역에 배치
            value: `[📄 상세 보기](${notice.link})  |  [📋 전체 목록](${LIST_URL})`,
            inline: false,
          },
        ],
        footer: {
          text: "Yonsei Mirae Notice Bot",
          // icon_url: "yonseiUniversityIcon.webp",
        },
        timestamp: new Date(),
      },
    ],
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL!, payload);
    console.log("✅ 디스코드 알림 전송 완료:", notice.id);
  } catch (error) {
    console.error("❌ 디스코드 전송 실패:", error);
  }
}

// 실행 함수
async function main() {
  console.log("🕵️ 새 공지 확인 중...");
  const lastSavedNotice = getLastNotice() || null;
  const latestNotices = await getLatestNotices(lastSavedNotice?.id || "0");

  if (!latestNotices) {
    console.log("📭 공지사항 목록을 불러올 수 없습니다.");
    return;
  }
  if (latestNotices.length === 0) {
    console.log("☕ 새로운 공지가 없습니다.");
    console.log(
      `✅ 마지막 공지: ${lastSavedNotice?.title || "없음"} (ID: ${
        lastSavedNotice?.id || "없음"
      })`
    );
    return;
  }

  console.log(
    `🔍 최신 공지 ID: ${latestNotices[0].id} (이전 기록: ${
      lastSavedNotice?.id || "없음"
    })`
  );

  if (Number(latestNotices[0].id) > Number(lastSavedNotice?.id || "0")) {
    console.log("🆕 새로운 공지가 발견되었습니다! 알림을 보냅니다.");
    for (const notice of latestNotices) {
      console.log(`📢 새 공지: ${notice.title} (ID: ${notice.id})`);
      await sendDiscordNotification(notice);
      await sleep(1500);
    }
    saveLastId(latestNotices[0]);
    console.log(`✅ 마지막 ID가 ${latestNotices[0].id}로 업데이트되었습니다.`);
  } else {
    console.log("☕ 새로운 공지가 없습니다.");
  }
}

main();
