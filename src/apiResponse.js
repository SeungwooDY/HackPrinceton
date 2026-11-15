export async function readJsonResponse(response, name = 'Backend API') {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`${name} returned HTTP ${response.status} instead of JSON. The deployment may be missing its backend API routes.`);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${name} returned invalid JSON. Check the server or Vercel Function logs.`); }
  if (!response.ok) throw new Error(data?.error || `${name} failed (HTTP ${response.status}).`);
  return data;
}
