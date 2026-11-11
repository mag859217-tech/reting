
// Запуск: node server.js
// Открыть: http://localhost:3000
// Требуется Node.js 18+

const http = require("http");
const fs = require("fs");
const path = require("path");

const UPSTREAM = "https://api.newlxp.ru/graphql";
const PORT = 3000;

// Разрешённые статические файлы
const STATIC_FILES = {
    "/": {
        file: "index.html",
        type: "text/html; charset=utf-8"
    },
    "/index.html": {
        file: "index.html",
        type: "text/html; charset=utf-8"
    },
    "/style.css": {
        file: "style.css",
        type: "text/css; charset=utf-8"
    },
    "/app.js": {
        file: "app.js",
        type: "application/javascript; charset=utf-8"
    }
};

const server = http.createServer(async (req, res) => {

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    // =========================
    // СТАТИЧЕСКИЕ ФАЙЛЫ
    // =========================

    if (req.method === "GET" || req.method === "HEAD") {

        const asset = STATIC_FILES[pathname];

        if (asset) {
            const filePath = path.join(__dirname, asset.file);

            fs.readFile(filePath, (err, data) => {

                if (err) {
                    console.error("Ошибка чтения файла:", asset.file);

                    res.writeHead(500, {
                        "Content-Type": "text/plain; charset=utf-8"
                    });

                    return res.end("Ошибка загрузки файла: " + asset.file);
                }

                res.writeHead(200, {
                    "Content-Type": asset.type,
                    "Cache-Control": "no-cache"
                });

                return res.end(req.method === "HEAD" ? undefined : data);
            });

            return;
        }
    }

    // =========================
    // GRAPHQL ПРОКСИ
    // =========================

    if (req.method === "POST" && pathname === "/graphql") {

        let body = "";

        try {

            for await (const chunk of req) {
                body += chunk;
            }

            const headers = {
                "Content-Type": "application/json",
                "apollographql-client-name": "web"
            };

            if (req.headers.authorization) {
                headers.authorization = req.headers.authorization;
            }

            const response = await fetch(UPSTREAM, {
                method: "POST",
                headers,
                body
            });

            const text = await response.text();

            console.log(
                "Платформа ответила HTTP " + response.status
            );

            res.writeHead(response.status, {
                "Content-Type": "application/json; charset=utf-8"
            });

            return res.end(text);

        } catch (error) {

            console.error("Ошибка GraphQL:", error);

            res.writeHead(502, {
                "Content-Type": "application/json; charset=utf-8"
            });

            return res.end(JSON.stringify({
                errors: [{
                    message: "Ошибка прокси: " + error.message
                }]
            }));
        }
    }

    // =========================
    // 404
    // =========================

    res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Not found");
});

// =========================
// ЗАПУСК
// =========================

server.listen(PORT, () => {

    console.log("--------------------------------");
    console.log("IThub Rating запущен!");
    console.log("Сайт: http://localhost:" + PORT);
    console.log("CSS:  http://localhost:" + PORT + "/style.css");
    console.log("JS:   http://localhost:" + PORT + "/app.js");
    console.log("--------------------------------");

});
