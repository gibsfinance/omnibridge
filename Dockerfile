FROM node:20.11.1 as contracts

WORKDIR /contracts

COPY package.json package-lock.json ./
RUN npm i

COPY hardhat.config.ts hardhat.config.ts
COPY ./precompiled ./precompiled
COPY ./contracts ./contracts
RUN npm run compile

COPY flatten.sh flatten.sh
RUN npm run flatten

FROM node:20.11.1

WORKDIR /contracts

COPY package.json package-lock.json ./
RUN npm ci

COPY --from=contracts /contracts/build ./build
COPY --from=contracts /contracts/flats ./flats
COPY ./precompiled/PermittableToken.json ./precompiled/PermittableToken.json

COPY deploy.sh deploy.sh
COPY ./deploy ./deploy

ENV PATH="/contracts/:${PATH}"
