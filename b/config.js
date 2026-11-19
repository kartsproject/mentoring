/* 운영 설정 — Apps Script 웹앱 주소를 배포 후 여기에 넣습니다. */
window.MEET_CONFIG = {
  API: 'https://script.google.com/macros/s/AKfycbzFTTDzzT0LiGzo_xmFPCTMq2BvJYq8gXRJ5rs_RhaE8VWfZng4q1q51MVNOgzmdD7h/exec',
  TITLE: '무용분야 심화 멘토링',
  PREFIX: '발레_',            // 학생 표시 이름 앞말
  SLOT_MIN: 10,              // 1인 멘토링 시간(분)
  FEEDBACK_MIN: 8,           // 그중 피드백(분) — 이후 질의응답
  CONTACT: 'kgifted2026@naver.com',
  // 운영진(녹화 창)으로 로그인하면 처음에 저장 폴더·권한을 받고, 접속한 순간부터 계속 자동 녹화합니다
  // (멘토링 아닌 시간은 「대기」 파일로 따로 저장). 폴더 자동 저장이 되는 PC 크롬·엣지에서만 녹화합니다.
  AUTO_RECORD_OPS: true,
  GAP_SPLIT_MIN: 30,         // 대기 시간 녹화는 이 분마다 파일을 나눔
  CAM_43: true               // 카메라를 4:3(960×720)으로 — 멘토링실·대기실 칸이 4:3
};
