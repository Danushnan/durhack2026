FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

FROM nginx:1.28-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY frontend/resolver.sh /resolver.sh
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/resolver.sh"]
CMD ["nginx", "-g", "daemon off;"]
