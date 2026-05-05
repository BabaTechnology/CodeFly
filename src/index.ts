import { startHostClient } from "./server";

void startHostClient().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
