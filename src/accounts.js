import fs from "node:fs";
import path from "node:path";
import { notifyChange } from "./events.js";
import { NotFoundError, ValidationError, localDate, newId } from "./util.js";

function checkName(name) {
  const trimmed = String(name ?? "").trim();
  if (trimmed.length < 1 || trimmed.length > 50) {
    throw new ValidationError("Tên tài khoản phải từ 1 đến 50 ký tự");
  }
  return trimmed;
}

export function createAccountService({ store, profilesDir, now = () => new Date() }) {
  const today = () => localDate(now());

  function mutate(id, fn) {
    let result;
    store.update((list) => {
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) throw new NotFoundError("Không tìm thấy tài khoản");
      list[i] = fn({ ...list[i] });
      result = list[i];
      return list;
    });
    notifyChange();
    return result;
  }

  const usageToday = (account) => (account.usage?.date === today() ? account.usage.jobs : 0);

  return {
    list: () => store.read(),
    get: (id) => store.read().find((a) => a.id === id),
    profileDir: (id) => path.join(profilesDir, id),
    usageToday,

    create(name) {
      const account = {
        id: newId("acc"),
        name: checkName(name),
        enabled: true,
        state: "needs_login",
        cooldownUntil: null,
        restUntil: null,
        usage: { date: today(), jobs: 0 },
        lastUsedAt: null,
        lastError: null,
        createdAt: now().toISOString(),
      };
      store.update((list) => [...list, account]);
      notifyChange();
      return account;
    },

    update(id, patch) {
      return mutate(id, (a) => {
        if (patch.name !== undefined) a.name = checkName(patch.name);
        if (patch.enabled !== undefined) a.enabled = Boolean(patch.enabled);
        return a;
      });
    },

    remove(id) {
      store.update((list) => {
        if (!list.some((a) => a.id === id)) throw new NotFoundError("Không tìm thấy tài khoản");
        return list.filter((a) => a.id !== id);
      });
      fs.rmSync(path.join(profilesDir, id), { recursive: true, force: true });
      notifyChange();
    },

    setState(id, state, extra = {}) {
      return mutate(id, (a) => {
        a.state = state;
        a.cooldownUntil = state === "cooldown" ? extra.cooldownUntil ?? null : null;
        if (extra.lastError !== undefined) a.lastError = extra.lastError;
        else if (state === "ready") a.lastError = null;
        return a;
      });
    },

    recordJobStart(id) {
      return mutate(id, (a) => {
        a.usage = { date: today(), jobs: usageToday(a) + 1 };
        a.lastUsedAt = now().toISOString();
        return a;
      });
    },

    setRest(id, untilIso) {
      return mutate(id, (a) => ({ ...a, restUntil: untilIso }));
    },

    // Chạy mỗi vài giây nên chỉ ghi file khi thật sự có tài khoản hết thời gian nghỉ.
    refreshCooldowns() {
      const t = now().getTime();
      const expired = (a) => a.state === "cooldown" && a.cooldownUntil && Date.parse(a.cooldownUntil) <= t;
      if (!store.read().some(expired)) return false;
      store.update((list) => list.map((a) => (expired(a) ? { ...a, state: "ready", cooldownUntil: null } : a)));
      notifyChange();
      return true;
    },
  };
}
