import { describe, expect, test } from "bun:test";
import { RequestTracker, type PendingRequest } from "./pending-requests";

/** A request whose timer does nothing, recording what it was told. */
function tracked() {
  const settled: string[] = [];
  let cancelled = 0;
  const request: PendingRequest = {
    resolve: () => settled.push("resolved"),
    reject: (err) => settled.push(`rejected: ${err.message}`),
    cancelTimer: () => {
      cancelled += 1;
    },
  };
  return { request, settled, cancelled: () => cancelled };
}

describe("RequestTracker", () => {
  test("一个能写出的请求不会被排队", () => {
    const tracker = new RequestTracker();
    const { request } = tracked();
    tracker.register("a", request, { id: "a" }, () => true);
    expect(tracker.queued).toBe(0);
    expect(tracker.outstanding).toBe(1);
  });

  test("写不出的请求被留在队列里，而不是丢掉", () => {
    // 这是 bug 的核心：连接还在握手时 send 会失败，
    // 若把帧丢掉，服务端永远看不到请求，调用方就永远等下去。
    const tracker = new RequestTracker();
    const { request } = tracked();
    tracker.register("a", request, { id: "a" }, () => false);
    expect(tracker.queued).toBe(1);
    expect(tracker.outstanding).toBe(1);
  });

  test("flush 按顺序写出排队的帧", () => {
    const tracker = new RequestTracker();
    tracker.register("a", tracked().request, { id: "a" }, () => false);
    tracker.register("b", tracked().request, { id: "b" }, () => false);

    const written: unknown[] = [];
    tracker.flush((frame) => {
      written.push(frame);
      return true;
    });

    expect(written).toEqual([{ id: "a" }, { id: "b" }]);
    expect(tracker.queued).toBe(0);
  });

  test("flush 中途写不出时保留剩余的帧", () => {
    const tracker = new RequestTracker();
    tracker.register("a", tracked().request, { id: "a" }, () => false);
    tracker.register("b", tracked().request, { id: "b" }, () => false);

    let allowed = 1;
    tracker.flush(() => {
      if (allowed === 0) return false;
      allowed -= 1;
      return true;
    });

    // 第一个写出去了，第二个还在队列里等着下一次 flush。
    expect(tracker.queued).toBe(1);
  });

  test("resolve 把回复交给调用方并且只交付一次", () => {
    const tracker = new RequestTracker();
    const { request, settled, cancelled } = tracked();
    tracker.register("a", request, {}, () => true);

    expect(tracker.resolve("a", { ok: true })).toBe(true);
    expect(tracker.resolve("a", { ok: true })).toBe(false);
    expect(settled).toEqual(["resolved"]);
    // 定时器必须被取消，否则失败的兜底会对一个已经完成的请求报错。
    expect(cancelled()).toBe(1);
  });

  test("fail 只对仍然在等的请求报错", () => {
    const tracker = new RequestTracker();
    const { request, settled } = tracked();
    tracker.register("a", request, {}, () => true);

    expect(tracker.fail("a", new Error("timed out"))).toBe(true);
    // 迟到的定时器不该给一个已经有结果的请求再报一次错。
    expect(tracker.fail("a", new Error("timed out"))).toBe(false);
    expect(settled).toEqual(["rejected: timed out"]);
  });

  test("failAll 连排队的帧一起清掉", () => {
    // 连接被放弃时，队列里的帧同样不会有人回答：
    // 之后再补发只会收到调用方已经放弃的请求的回复。
    const tracker = new RequestTracker();
    const first = tracked();
    const second = tracked();
    tracker.register("a", first.request, { id: "a" }, () => false);
    tracker.register("b", second.request, { id: "b" }, () => true);

    tracker.failAll(new Error("connection closed"));

    expect(tracker.queued).toBe(0);
    expect(tracker.outstanding).toBe(0);
    expect(first.settled).toEqual(["rejected: connection closed"]);
    expect(second.settled).toEqual(["rejected: connection closed"]);
  });

  test("回复一个未知的 id 不会做任何事", () => {
    const tracker = new RequestTracker();
    expect(tracker.resolve("nope", {})).toBe(false);
    expect(tracker.fail("nope", new Error("x"))).toBe(false);
  });
});
