import http.client, json, time, socket, subprocess, base64, statistics, os
REGION = os.environ.get('REGION', '?')
PROJECT = 'creatorain-27e9e'
import urllib.request
_req = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', headers={'Metadata-Flavor': 'Google'})
TOKEN = json.loads(urllib.request.urlopen(_req).read())['access_token']
FORGED = 'v1.soak-reservation.soak-attempt.4102444800000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
N = 15
STT_MODEL = os.environ.get('STT_MODEL', '')
out = {'region': REGION, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'probes': {}}


def tcp_rtt(host):
    ts = []
    for _ in range(5):
        t = time.perf_counter()
        s = socket.create_connection((host, 443), timeout=10)
        ts.append((time.perf_counter() - t) * 1000)
        s.close()
    return round(min(ts), 1)


def run(name, host, path, body, headers):
    res = {'host': host, 'tcp_connect_min_ms': tcp_rtt(host)}
    data = json.dumps(body).encode()
    t = time.perf_counter()
    c = http.client.HTTPSConnection(host, timeout=30)
    c.request('POST', path, data, headers)
    r = c.getresponse()
    payload = r.read()
    res['cold_ms'] = round((time.perf_counter() - t) * 1000, 1)
    res['status'] = r.status
    warm = []
    for _ in range(N):
        t = time.perf_counter()
        c.request('POST', path, data, headers)
        r = c.getresponse()
        payload = r.read()
        warm.append(round((time.perf_counter() - t) * 1000, 1))
    c.close()
    res['warm_ms'] = warm
    res['warm_p50_ms'] = round(statistics.median(warm), 1)
    res['warm_max_ms'] = max(warm)
    res['last_status'] = r.status
    out['probes'][name] = res
    return payload


auth = {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'x-goog-user-project': PROJECT}
run('seam_call_context_forged', 'datadev.creatorain.com', '/reservations/call-context', {},
    {'Authorization': 'Bearer ' + FORGED, 'Content-Type': 'application/json'})
tts = run('tts_chirp3_aoede_mulaw8k', 'texttospeech.googleapis.com', '/v1/text:synthesize',
          {'input': {'text': 'Thanks, one moment while I check that.'},
           'voice': {'languageCode': 'en-US', 'name': 'en-US-Chirp3-HD-Aoede'},
           'audioConfig': {'audioEncoding': 'MULAW', 'sampleRateHertz': 8000}}, auth)
raw = base64.b64decode(json.loads(tts).get('audioContent', ''))
if raw[:4] == b'RIFF':
    raw = raw[44:]
out['tts_audio_bytes'] = len(raw)
run('stt_v2_recognize_us', 'us-speech.googleapis.com',
    '/v2/projects/' + PROJECT + '/locations/us/recognizers/_:recognize',
    {'config': {'explicitDecodingConfig': {'encoding': 'MULAW', 'sampleRateHertz': 8000, 'audioChannelCount': 1},
                'model': STT_MODEL, 'languageCodes': ['en-US']},
     'content': base64.b64encode(raw).decode()}, auth)
run('vertex_flash_lite_global', 'aiplatform.googleapis.com',
    '/v1/projects/' + PROJECT + '/locations/global/publishers/google/models/gemini-3.5-flash-lite:generateContent',
    {'contents': [{'role': 'user', 'parts': [{'text': 'The restaurant said: "yes we are open tonight". Answer with one word: yes, no or unclear.'}]}],
     'generationConfig': {'maxOutputTokens': 8}}, auth)
for loc in ('us-east4', 'us-central1'):
    try:
        run('vertex_flash_lite_' + loc, loc + '-aiplatform.googleapis.com',
            '/v1/projects/' + PROJECT + '/locations/' + loc + '/publishers/google/models/gemini-3.5-flash-lite:generateContent',
            {'contents': [{'role': 'user', 'parts': [{'text': 'The restaurant said: "yes we are open tonight". Answer with one word: yes, no or unclear.'}]}],
             'generationConfig': {'maxOutputTokens': 8}}, auth)
    except Exception as e:
        out['probes']['vertex_flash_lite_' + loc] = {'error': repr(e)}
print('PROBE_JSON ' + json.dumps(out))
