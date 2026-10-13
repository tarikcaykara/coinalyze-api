import { expect, test } from "bun:test";
import { BrowserManager, type BrowserLike } from "../scripts/calibrate/browser.ts";

const fakeLauncher = () => {
  const instances: { closes: number; connected: boolean }[] = [];
  const launch = async (): Promise<BrowserLike> => {
    const state = { closes: 0, connected: true };
    instances.push(state);
    return {
      newPage: async () => {
        throw new Error("not used");
      },
      close: async () => {
        state.closes++;
        state.connected = false;
      },
      isConnected: () => state.connected,
    };
  };
  return { instances, launch };
};

test("get() reuses the tracked instance; restart() closes each previous instance once", async () => {
  const { instances, launch } = fakeLauncher();
  const manager = new BrowserManager({ launch });

  const first = await manager.get();
  expect(await manager.get()).toBe(first);
  expect(instances.length).toBe(1);

  await manager.restart();
  await manager.restart();
  expect(instances.length).toBe(3);
  expect(instances.map((i) => i.closes)).toEqual([1, 1, 0]);

  await manager.close();
  expect(instances.map((i) => i.closes)).toEqual([1, 1, 1]);
});

test("get() relaunches after the browser disconnects", async () => {
  const { instances, launch } = fakeLauncher();
  const manager = new BrowserManager({ launch });
  const first = await manager.get();
  instances[0]!.connected = false;
  const second = await manager.get();
  expect(second).not.toBe(first);
  expect(instances.length).toBe(2);
});
