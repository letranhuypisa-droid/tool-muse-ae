// code: "NOT_LOGGED_IN" | "TIMEOUT" | "BROWSER"
export class MuseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MuseError";
    this.code = code;
  }
}
