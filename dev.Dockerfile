FROM node:16.15.0-alpine

RUN apk add g++ make python3

WORKDIR /app
COPY . ./

RUN yarn

RUN yarn dev

EXPOSE 3000

ENTRYPOINT [ "yarn", "start" ]
