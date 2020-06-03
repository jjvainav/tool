import { IModuleConfigurator } from "@shrub/core";
import { ExpressFactory, ExpressModule, IExpressConfiguration, useController } from "@shrub/express";
import { ExpressTracingModule, useRequestTracing } from "@shrub/express-tracing";
import { IMessagingEventStreamConfiguration, MessagingEventStreamModule } from "@shrub/messaging-event-stream";
import { TracingConsoleModule } from "@shrub/tracing-console";
import * as express from "express";
import * as path from "path";
import { Controller } from "./controller";

async function start() {
    const app = await ExpressFactory
        .useModules([{
            name: "consumer",
            dependencies: [
                ExpressModule,
                ExpressTracingModule,
                MessagingEventStreamModule,
                TracingConsoleModule
            ],
            configure: ({ config }: IModuleConfigurator) => {
                config.get(IMessagingEventStreamConfiguration).useEventStreamConsumer({
                    endpoints: [{
                        // this indicates the endpoint will handle all channel names
                        channelNamePatterns: ["*"],
                        url: "http://localhost:3000/api/messages/bind"
                    }]
                });

                const app = config.get(IExpressConfiguration);

                app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
                app.get(/\/public(.*)/, express.static(__dirname, { fallthrough: false }));

                app.use(express.json());
                app.use(useRequestTracing());
                app.use(useController(Controller));
            }
        }])
        .create();

    app.set("port", process.env.PORT || 3001);
    app.listen(app.get("port"), () => {
        console.log("  Consumer started at http://localhost:%d", app.get("port"));
        console.log("  Consumer running");
        console.log("  Press CTRL-C to stop\n");
    });           
}

start();