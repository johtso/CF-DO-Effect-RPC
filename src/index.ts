import { DurableObject } from 'cloudflare:workers';

import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { MixedScheduler } from 'effect/Scheduler';
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from '@effect/rpc';
import { FetchHttpClient, HttpApp } from '@effect/platform';

class RpcHello extends RpcGroup.make(
  Rpc.make('Hello', {
    error: Schema.Void,
    success: Schema.String,
    payload: Schema.Void,
  })
) {}

class RpcHelloClient extends Effect.Service<RpcHelloClient>()('RpcHelloClient', {
  effect: RpcClient.make(RpcHello).pipe(Effect.scoped),
}) {}

const RpcHelloLayer = RpcHello.toLayer(
  Effect.gen(function* () {
    return {
      Hello: () => Effect.succeed('World'),
    };
  })
);

const RpcHelloWebHandler = RpcServer.toHttpApp(RpcHello).pipe(
  Effect.map(HttpApp.toWebHandler),
  Effect.provide([RpcHelloLayer, RpcSerialization.layerNdjson])
);

const RpcProtocol = RpcClient.layerProtocolHttp({
  url: '',
}).pipe(Layer.provide(RpcSerialization.layerNdjson));

const makeRuntime = (ctx: DurableObjectState, env: Env) => {
  const scheduler = new MixedScheduler(Infinity);

  return ManagedRuntime.make(Layer.setScheduler(scheduler));
};

export class MyDurableObject extends DurableObject<Env> {
  private runtime: ReturnType<typeof makeRuntime>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = makeRuntime(ctx, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const handler = await this.runtime.runPromise(RpcHelloWebHandler.pipe(Effect.scoped));
    return handler(request);
  }
}

const customFetchHttpClient = (_fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, _fetch)));

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName('hello');
    const stub = env.MY_DURABLE_OBJECT.get(id);

    const RpcHelloClientLive = RpcHelloClient.Default.pipe(
      Layer.provide(RpcProtocol.pipe(Layer.provide(customFetchHttpClient(stub.fetch))))
    );

    const runtime = ManagedRuntime.make(RpcHelloClientLive);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcHelloClient;
        return yield* client.Hello();
      })
    );
    return new Response(JSON.stringify(result));
  },
} satisfies ExportedHandler<Env>;
