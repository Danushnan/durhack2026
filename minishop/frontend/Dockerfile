FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
ARG KUEBEC_URL=http://127.0.0.1:15173
ENV VITE_KUEBEC_URL=${KUEBEC_URL}
RUN npm run build

FROM nginx:1.28-alpine
ARG KUEBEC_URL=http://127.0.0.1:15173
ENV KUEBEC_URL=${KUEBEC_URL}
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY frontend/resolver.sh /resolver.sh
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/resolver.sh"]
CMD ["nginx", "-g", "daemon off;"]
