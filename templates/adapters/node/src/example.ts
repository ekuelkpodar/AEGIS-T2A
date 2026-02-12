import { SimulatedTwilioAdapter } from "./twilio_simulated.js";

async function main() {
  const adapter = new SimulatedTwilioAdapter();

  await adapter.connect({
    accountSid: "ACXXXX",
    authTokenRef: "TWILIO_AUTH_TOKEN",
    fromPhone: "+15550001111",
  });

  const payload = {
    toPhone: "+15550002222",
    message: "Route update: pickup moved to Dock 4.",
    routeId: "route-2026-02-12-001",
  };

  const simulation = await adapter.simulate(payload, {
    tenantId: "tenant-a",
    correlationId: "corr-123",
    actorId: "agent-dispatcher",
    mode: "sandbox",
  });

  const execution = await adapter.execute(payload, {
    tenantId: "tenant-a",
    correlationId: "corr-123",
    actorId: "agent-dispatcher",
    mode: "sandbox",
  });

  console.log({ simulation, execution });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
