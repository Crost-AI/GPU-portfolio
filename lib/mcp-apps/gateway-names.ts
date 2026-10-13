// The gateway tools' names (./gateway.ts), apart from the gateway itself so /api/agent can
// recognise them without importing the MCP server and its embedded view.

export const SEARCH_TOOLS = 'search_tools'
export const CALL_TOOL = 'call_tool'

export function isGatewayTool(name: unknown): boolean {
  return name === SEARCH_TOOLS || name === CALL_TOOL
}
