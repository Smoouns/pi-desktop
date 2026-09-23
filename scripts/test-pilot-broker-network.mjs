import { runPilotBrokerNetworkTests } from "../tests/pilot/broker-network.mjs";

const count = await runPilotBrokerNetworkTests();
console.log(`Pilot broker network tests passed: ${count}`);
