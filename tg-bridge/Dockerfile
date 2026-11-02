# خدمة tg-bridge (الإصدار 76): «خادم البوتات المحلي» الرسمي من تيليجرام (tdlib/telegram-bot-api) + عامل صغير
# يأخذ فيديوهات قنوات المشايخ ويمرّرها لخادم الموقع لينشرها في فيسبوك. الحد: حتى 2000MB بدل 20MB.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates cmake g++ make gperf zlib1g-dev libssl-dev \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --recursive --depth 1 --shallow-submodules https://github.com/tdlib/telegram-bot-api.git /src
WORKDIR /src/build
RUN cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. && cmake --build . --target install -j 2

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates zlib1g libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api
WORKDIR /app
COPY worker.mjs ./
CMD ["node", "/app/worker.mjs"]
