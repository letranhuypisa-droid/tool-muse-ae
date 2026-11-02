// Driver giả có cùng giao diện với driver thật; handler quyết định mỗi lượt trả gì.
export function createFakeDriver(handler, { loggedIn = true } = {}) {
  const calls = [];
  const closed = [];
  const opened = [];
  return {
    calls,
    closed,
    opened,
    async openWindow(accountId) {
      opened.push(accountId);
    },
    async checkLoggedIn() {
      return typeof loggedIn === "function" ? loggedIn() : loggedIn;
    },
    async runTurn(accountId, { message, files = [] }) {
      calls.push({ accountId, message, files: [...files] });
      return handler(accountId, { message, files }, calls.length - 1);
    },
    async close(accountId) {
      closed.push(accountId);
    },
    async closeAll() {},
    isOpen: () => false,
  };
}
