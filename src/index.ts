import { DurableObject } from 'cloudflare:workers';

import { Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { MixedScheduler } from 'effect/Scheduler';
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from '@effect/rpc';
import { FetchHttpClient, HttpServer } from '@effect/platform';

class RpcHello extends RpcGroup.make(
  Rpc.make('Hello', {
    error: Schema.Void,
    success: Schema.String,
    payload: Schema.Void,
  })
) {}

class RpcHelloClient extends Effect.Service<RpcHelloClient>()('RpcHelloClient', {
  scoped: RpcClient.make(RpcHello),
}) {}

const RpcHelloLayer = RpcHello.toLayer(
  Effect.gen(function* () {
    return {
      Hello: () => Effect.succeed('World'),
    };
  })
);

const RpcProtocol = RpcClient.layerProtocolHttp({
  // Cloudflare requires a valid looking URL
  url: 'http://internal.invalid/api/rpc',
}).pipe(Layer.provide(RpcSerialization.layerNdjson));

const makeAppLayer = (ctx: DurableObjectState, env: Env) => {
  // Disable Effect's scheduler's default setTimeout behaviour to avoid possibility of switching to another request
  // between storage operations..?
  const scheduler = new MixedScheduler(Infinity);
  return Layer.mergeAll(RpcHelloLayer, Layer.setScheduler(scheduler));
};

export class MyDurableObject extends DurableObject<Env> {
  private handler: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const AppLayer = makeAppLayer(ctx, env);
    const { handler, dispose } = RpcServer.toWebHandler(RpcHello, {
      layer: Layer.mergeAll(AppLayer, RpcSerialization.layerNdjson, HttpServer.layerContext),
    });
    this.handler = handler;
  }

  override async fetch(request: Request): Promise<Response> {
    return this.handler(request);
  }
}

const customFetchHttpClient = (_fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, _fetch)));

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const id = env.MY_DURABLE_OBJECT.idFromName('hello');
    const stub = env.MY_DURABLE_OBJECT.get(id);

    const RpcHelloClientLive = RpcHelloClient.Default.pipe(
      // Note: We have to bind the stub's fetch method
      Layer.provide(RpcProtocol.pipe(Layer.provide(customFetchHttpClient(stub.fetch.bind(stub)))))
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
