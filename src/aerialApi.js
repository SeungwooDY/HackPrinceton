const unavailable = 'The aerial API is unavailable. Restart the local server with python3 serve.py, then retry.';

export async function readAerialJson(response) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(unavailable);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The aerial server returned an invalid response. Restart python3 serve.py, then retry.');
  }
  if (!response.ok) throw new Error(data?.error || 'Unable to load aerial imagery. Please retry.');
  return data;
}
