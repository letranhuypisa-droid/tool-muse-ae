import { EventEmitter } from "node:events";

// Báo cho giao diện (qua SSE) rằng dữ liệu vừa đổi.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function notifyChange() {
  bus.emit("change");
}
