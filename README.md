# penguin

There are many factories, but this one is _yours_

## Getting started

There are three concepts you need to know in order to get started:

1. Workflows
2. Adapters
3. Messages

Let's go through each

### Workflows

These are the heart of everything. You run your agent, call adapters, and respond to messages all from the workflows.

Workflows are written in TypeScript and are meant to be simple to build and even simpler to use.

Workflows are the brains of the operation.

Workflows are composable.

### Adapters

These are workflows way of connecting with the outside world.

Some common adapters include Git, GitHub, Slack, Linear, Jira, Claude, Codex, etc.

You can easily build your own adapters.

### Messages

Messages are ways that the outside world interacts with the workflow. A message can trigger or queue things within the workflow.

## But Why, you ask

Let me tell you. Because.

All coding harnesses and code factories have a few major flaws:

1. You don't get to pick the workflow - someone else decides the workflow for you
2. It's often unclear when the human is needed - is the agent done, or do you need to verify?
3. You're limited to prose and all it's downsides - nested logic and complex composition is pretty much out of the question
4. We end up relying heavily on agents calling mcp's or cli's for things that should be deterministic calls

## You don't get to pick the workflow

Why should the guys at vercel, linear, factory, anthropic, or openai decide what workflow is best for you?

Penguin flips that:

_YOU_ decide what workflow is best.

Three concepts:
Workflows - what's run
Adapters - a way to connect to the outside world
Messages - async or sync sent between workflows and adapters

With these three primitives, you can build incredibly complex workflows including, but not limited to, software factories.

## It's often unclear when the human is needed

With Penguin, you can write deterministic pauses in workflow ("New messages from slack, would you like to pause implementing or read them after?")

When an agent stops it's either because the agent needs human input or because it is done. When done, the workflow moves on to the next step until a human is needed. There is clear separation between an agent finishing and human input needed.

## You're limited to prose and all it's downsides

If you want a workflow that runs another workflow that runs another workflow that runs several agents and it runs all those workflows in peralell, you just can't do that with prose very easily. Code is much more clear

The workflows and adapters all are written in TypeScript making it incredibly straightforward to build a new workflow or adapter.

## We end up relying heavily on agents calling mcp's or cli's for things that should be deterministic calls

When you implement a github issue, jira ticket, or review a PR, you are ALWAYS going to pull the info from those sources, and you can do this with a script. There's no need for the agent to use an MCP.

## Final notes

You can build a workflow that has steps, blockers, and all, without ever even calling an agent.

You can make workflows that respond to all kinds of triggers: Slack, GitHub, Jira, User, a webhook, anything you can bulid an adapter for

Penguin is the ultimately composable workflow builder

Still early beta, but I've already started using Penguin at work as well as to build Penguin!

## License

Apache License 2.0. See [LICENSE](LICENSE).
