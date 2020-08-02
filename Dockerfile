FROM "node:14.2-slim"

WORKDIR /code/

ADD ["package-lock.json", "package.json", "/code/"]

RUN npm install

ADD ["server", "/code/"]

CMD ["/bin/sh"]
