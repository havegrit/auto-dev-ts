export interface ClarificationQuestion {
  id: string;
  category: string;
  text: string;
  recommendation: string;
}

/** clarifier 게이트 한 라운드: 던진 질문 + (있으면) 사용자가 입력한 답변. */
export interface ClarificationRound {
  questions: ClarificationQuestion[];
  /** 질문 id → 사용자 답변. 아직 답하지 않은 라운드는 비어 있다. */
  answers?: Record<string, string>;
  /** 사용자가 직접 입력한 후속 수정 지시(질문 없이 스레드를 이어갈 때). */
  followup?: string;
}
