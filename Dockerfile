FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY server.js ./
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
EXPOSE 8080
CMD ["node", "--no-warnings", "server.js"]
