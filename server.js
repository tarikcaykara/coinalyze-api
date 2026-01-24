import "dotenv/config";

const PORT = process.env.PORT || 3000;
const headers = { api_key: process.env.COINALYZE_API_KEY };
const BASE_URL = process.env.BASE_URL;

const server = Bun.serve({
  port: PORT,
  routes: {
    "/": () => new Response("naber lan"),
    "/future-markets": async () => {
      const response = await fetch(`${BASE_URL}/future-markets`, { headers });
      if (!response.ok) {
        const errorMessage = await response.text();
        return new Response(
          JSON.stringify({
            message: "api error",
            status: response.status,
            details: errorMessage || "no details",
          }),
          {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const data = await response.json();
      return Response.json(data);
    },
  },
});

console.log(`server is running on port ${server.url}`);
