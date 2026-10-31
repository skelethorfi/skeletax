// A real process for the signal test: signals itself during the first entry's split, then finishes that entry.
import { runApply } from "../src/apply.ts";
import { FakeSumm } from "./fake-summ.ts";

const [dir, planDir] = process.argv.slice(2);
const summ = new FakeSumm();
summ.add("d", [
  { _id: "leg-9", trade: "withdrawal", quantity: "1" },
  { _id: "their-leg", trade: "deposit", quantity: "1" },
]);
summ.add("e", [{ _id: "leg-8", trade: "withdrawal", quantity: "1" }]);
const real = summ.callTool.bind(summ);
const client = Object.assign(summ, {
  connect: async () => {},
  callTool: async (name: string, args: Record<string, unknown>) => {
    if (name === "edit_transaction") {
      process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 50));
      if (process.argv[4] === "twice") {
        process.kill(process.pid, "SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return real(name, args);
  },
});
await runApply(client, dir, planDir, { approveDeletes: true, approveFiled: false, dryRun: false }, 0);
console.log(
  `left: ${[...summ.actions.values()]
    .flat()
    .map((l) => l._id)
    .sort()
    .join(",")}`,
);
