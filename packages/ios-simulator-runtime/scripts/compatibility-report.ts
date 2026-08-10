import { collectIOSSimulatorCompatibilityReport } from "../src/index.js";

const report = await collectIOSSimulatorCompatibilityReport();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
