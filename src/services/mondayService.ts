import axios from "axios";

export interface MondayItem {
  id: string;
  name: string;
  column_values: {
    id: string;
    text: string;
    value?: string;
  }[];
}

export const fetchMondayData = async (boardId: string, columnIds?: string[], forceRefresh = false, apiKey?: string) => {
  try {
    const response = await axios.post("/api/monday/all-items", { 
      boardId, 
      columnIds, 
      forceRefresh,
      apiKey
    });
    return response.data; // Returns { data: MondayItem[], fromCache: boolean }
  } catch (error) {
    console.error("Error fetching Monday.com data:", error);
    throw error;
  }
};

export const fetchBoards = async (forceRefresh = false, apiKey?: string) => {
  const query = `
    query {
      boards (limit: 100) {
        id
        name
      }
    }
  `;

  try {
    const response = await axios.post("/api/monday", { query, forceRefresh, apiKey });
    const boards = response.data?.data?.boards;
    if (!boards) throw new Error("No boards found in response.");
    return boards as { id: string; name: string }[];
  } catch (error) {
    console.error("Error fetching boards:", error);
    throw error;
  }
};

export const fetchColumns = async (boardId: string, apiKey?: string) => {
  const query = `
    query {
      boards (ids: ["${boardId}"]) {
        columns {
          id
          title
          type
        }
      }
    }
  `;

  try {
    const response = await axios.post("/api/monday", { query, apiKey });
    const board = response.data?.data?.boards?.[0];
    if (!board) throw new Error(`Board with ID ${boardId} not found or inaccessible.`);
    return (board.columns || []) as { id: string; title: string; type: string }[];
  } catch (error) {
    console.error("Error fetching columns:", error);
    throw error;
  }
};

export const fetchBoardSubscribers = async (boardId: string, apiKey?: string) => {
  const query = `
    query {
      boards (ids: ["${boardId}"]) {
        subscribers {
          id
          name
        }
      }
    }
  `;

  try {
    const response = await axios.post("/api/monday", { query, apiKey });
    const board = response.data?.data?.boards?.[0];
    if (!board) throw new Error(`Board with ID ${boardId} not found or inaccessible.`);
    return (board.subscribers || []) as { id: string; name: string }[];
  } catch (error) {
    console.error("Error fetching subscribers:", error);
    throw error;
  }
};
