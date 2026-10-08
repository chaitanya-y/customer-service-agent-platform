export async function safeEdgeFetch(
  endpoint: URL,
  options: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  // Never allow a server-held customer token to follow an Edge redirect.
  const response = await fetcher(endpoint, { ...options, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Customer Edge upstream redirect refused");
  }
  return response;
}
