import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Simple in-memory cache
  const cache = new Map<string, { data: any; timestamp: number }>();
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Monday.com API Proxy
  app.post("/api/monday", async (req, res) => {
    const { query, variables, forceRefresh, apiKey: clientApiKey } = req.body;
    const apiKey = clientApiKey || process.env.MONDAY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "MONDAY_API_KEY is not configured." });
    }
    const cacheKey = JSON.stringify({ query, variables });

    if (!forceRefresh && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
      }
    }

    try {
      const response = await axios.post(
        "https://api.monday.com/v2",
        { query, variables },
        {
          headers: {
            "Authorization": apiKey,
            "Content-Type": "application/json",
            "API-Version": "2023-10"
          },
        }
      );

      if (response.data && !response.data.errors) {
        cache.set(cacheKey, { data: response.data, timestamp: Date.now() });
      }

      res.json(response.data);
    } catch (error: any) {
      console.error("Monday.com API Error:", error.response?.data || error.message);
      res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
    }
  });

  // Specialized endpoint to fetch ALL items from a board (Server-side pagination)
  app.post("/api/monday/all-items", async (req, res) => {
    const { boardId, columnIds, forceRefresh, apiKey: clientApiKey } = req.body;
    const apiKey = clientApiKey || process.env.MONDAY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "MONDAY_API_KEY is not configured." });
    }
    const cacheKey = `all_items_${boardId}_${(columnIds || []).sort().join(",")}`;

    if (!forceRefresh && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json({ data: cached.data, fromCache: true });
      }
    }

    try {
      let allItems: any[] = [];
      let hasMore = true;
      let cursor: string | null = null;
      const columnFilter = columnIds && columnIds.length > 0 
        ? `(ids: [${columnIds.map((id: string) => `"${id}"`).join(",")}])` 
        : "";

      while (hasMore) {
        const query = cursor 
          ? `query { next_items_page (cursor: "${cursor}") { cursor items { id name column_values ${columnFilter} { id text value } } } }`
          : `query { boards (ids: ["${boardId}"]) { items_page (limit: 100) { cursor items { id name column_values ${columnFilter} { id text value } } } } }`;

        const response = await axios.post(
          "https://api.monday.com/v2",
          { query },
          {
            headers: {
              "Authorization": apiKey,
              "Content-Type": "application/json",
              "API-Version": "2023-10"
            },
            timeout: 30000 // 30 seconds timeout
          }
        );

        const result = response.data;
        if (result.errors) {
          throw new Error(result.errors[0].message);
        }

        if (cursor) {
          const page = result.data?.next_items_page;
          if (!page) throw new Error("No next_items_page found in response");
          allItems = [...allItems, ...page.items];
          cursor = page.cursor;
          hasMore = !!cursor;
        } else {
          const board = result.data?.boards?.[0];
          if (!board) throw new Error(`Board with ID ${boardId} not found or inaccessible.`);
          const page = board.items_page;
          if (!page) throw new Error("No items_page found for board");
          allItems = [...allItems, ...page.items];
          cursor = page.cursor;
          hasMore = !!cursor;
        }

        // Small delay between pages to avoid hitting rate limits and reduce server load
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      cache.set(cacheKey, { data: allItems, timestamp: Date.now() });
      res.json({ data: allItems, fromCache: false });
    } catch (error: any) {
      console.error("Monday.com All Items Error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
