# penguin

There are many factories, but this one is _yours_

## Getting started

There are two concepts you need to know:

1. Workflows - what's run. Plain TypeScript functions. You call adapters, run agents, and decide what the human sees, all from here. Workflows are composable: workflows call workflows.
2. Adapters - a workflow's bridge to the outside world. Git, GitHub, Slack, Linear, Jira, Claude, Codex, whatever. Plain functions over plain data. You can easily build your own.

The human is one more outside thing, so talking to them is one more adapter: `view.show(...)` to tell them something, `view.ask(...)` to wait on their answer. And when something outside keeps talking back, that's not a new concept either: an adapter function just returns an async stream, and the workflow reads it.

With these two things you can build incredibly complex workflows, including, but not limited to, software factories.

## But why, you ask

Let me tell you. Because.

Every coding harness and code factory has the same flaws:

1. Someone else decides the workflow for you
2. It's unclear when the human is needed
3. You're stuck describing logic in prose
4. Agents call MCPs and CLIs for things that should be deterministic calls

### You don't get to pick the workflow

Why should the guys at Vercel, Linear, Factory, Anthropic, or OpenAI decide what workflow is best for you?

Penguin flips that. _You_ decide.

### It's unclear when the human is needed

Is the agent done, or is it waiting on you? With most tools you find out by scrolling.

In Penguin the distinction is built in. An agent turn ends in a typed result you define. A workflow can pause on a question (`view.ask("Ship it?")`) and does not move until you answer. When nothing needs you, it keeps moving on its own.

### You're limited to prose

If you want a workflow that runs another workflow that runs several agents, all in parallel, prose falls apart fast. Code doesn't. Loops, retries, conditions, composition: TypeScript already does all of that, so that's what workflows are written in.

### Agents shouldn't fetch what a script can fetch

When you implement a GitHub issue or a Jira ticket, or review a PR, you are ALWAYS going to pull the info from those sources first. That's a deterministic call, not a job for an agent poking at an MCP. Adapters make it one function call.

## Final notes

You can build a workflow with steps and blockers without ever calling an agent.

Workflows can respond to anything you can build an adapter for: Slack, GitHub, Jira, a webhook, you.

Still early beta, but I'm already using Penguin at work, and to build Penguin.

## License

Apache License 2.0. See [LICENSE](LICENSE).
