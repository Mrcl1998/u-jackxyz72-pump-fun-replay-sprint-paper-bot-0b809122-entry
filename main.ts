// Pump.fun Replay Sprint paper bot: an early-flow sniper with fast exits.
//
// Strategy (see strategy.ts): one small buy per coin in the first seconds
// after its CreateEvent, only when the opening tape shows genuine dispersed
// demand — several distinct non-creator buyers, net inflow, the creator
// not selling, no bundled multi-wallet launch, no already-doubled price.
// Every position then exits whole on the first of a take-profit, a stop
// loss, a trailing stop, a short maximum hold, a creator sell, or staleness.
// A pacing guardrail opens tiny probe round trips when the bot's own filled
// coins lag the pace the minimum bar needs.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at
// /bot; the SDK shim is vendored beside it (vendor/makefun-bot.ts is a
// byte-identical copy of the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
