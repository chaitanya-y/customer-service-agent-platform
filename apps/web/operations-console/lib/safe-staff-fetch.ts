export async function safeStaffFetch(
  endpoint: URL,
  options: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  // Local staff JWTs are server-held. Never forward them through an HTTP redirect.
  const response = await fetcher(endpoint, { ...options, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Staff upstream redirect refused");
  }
  return response;
}
