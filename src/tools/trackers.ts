import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GongClient } from "../gong-client.js";

export function registerTrackerTools(server: McpServer, client: GongClient) {
  server.tool(
    "get_trackers",
    "List keyword trackers configured in your Gong workspace.",
    {
      workspaceId: z.string().optional().describe("Optional workspace ID to filter trackers"),
    },
    async (params: { workspaceId?: string }) => {
      const trackers = await client.getTrackers(params.workspaceId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(trackers, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "list_workspaces",
    "List all Gong workspaces.",
    {},
    async () => {
      const workspaces = await client.listWorkspaces();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(workspaces, null, 2),
          },
        ],
      };
    }
  );
}
