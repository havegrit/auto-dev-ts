let installed = false;

/**
 * SSH 세션이 닫힐 때 서버까지 함께 종료되지 않도록 한다.
 *
 * systemd user service가 권장 실행 경로지만, SSH에서 직접 `serve`를
 * 시작하는 경우에도 대시보드가 시작한 background spec을 보호해야 한다.
 * SIGHUP은 자식 프로세스에 상속되므로 provider CLI도 같은 보호를 받는다.
 */
export function keepRunningAfterSessionDisconnect(): void {
  if (installed) return;
  installed = true;
  process.on('SIGHUP', () => {
    // SSH/terminal disconnect. Intentionally keep the server and active runs alive.
  });
}
