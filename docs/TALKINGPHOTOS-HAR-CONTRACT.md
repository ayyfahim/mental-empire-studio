# TalkingPhotos HAR integration contract

Verified 2026-07-20 from ten supplied captures. Capture indices below are zero-based HAR entry indices. Authentication headers, cookies, account data, signed media URLs, local filenames, prompts, and user-authored text are intentionally omitted or replaced with descriptive placeholders.

## Audit result

`app.talkingphotos.ai new.har`, entry 55, conclusively confirms an uploaded-audio Human project. It is the first captured `POST /project` with `options.audioSource = "library"`. Its `options.audioMediaId` is the media ID returned by the preceding trim response, while TTS text and TTS result fields are empty.

The nine earlier files were rechecked before accepting this contract:

| HAR file | `POST /project` entries | Result |
|---|---:|---|
| `app.talkingphotos.ai p7.har` | 0 | no project submission |
| `app.talkingphotos.ai p6.har` | 0 | no project submission |
| `app.talkingphotos.ai p5.har` | 2 (6, 41) | Human, normal, TTS; first returns 422 for missing motion, second returns pending |
| `app.talkingphotos.ai p4.har` | 0 | no project submission |
| `app.talkingphotos.ai p3.har` | 0 | no project submission |
| `app.talkingphotos.ai p2.har` | 0 | no project submission |
| `app.talkingphotos.ai p1.har` | 0 | no project submission |
| `app.talkingphotos.ai 2.har` | 0 | no direct project submission; entry 5 confirms merge submission |
| `app.talkingphotos.ai.har` | 1 (28) | Human, normal, TTS, pending |
| `app.talkingphotos.ai new.har` | 1 (55) | Human, high quality, uploaded/library audio, pending |

## Confirmed uploaded-audio sequence

1. Entry 42: `POST /ai_api/create_image_from_prompt` returns a generated-character UUID.
2. Entry 50: `POST /library/categories/upload/{categoryId}` sends multipart `file` and `type=audio`; the response returns the source audio media ID and duration (829.2 seconds in this capture).
3. Entry 54: `POST /ai_api/trim_media` sends `mediaId`, `timeStart`, `timeEnd`, `title`, and `useFadeOut=false`; the response returns a new 60-second audio media ID.
4. Entry 55: `POST /project` uses that trimmed ID in `options.audioMediaId` with `audioSource="library"`.

The upload alone is not treated as proof. The link between steps 3 and 4 is the evidence that the uploaded/custom audio is the Human project's input.

### Sanitized exact project request

```json
{
  "title": "<project-title>",
  "type": "human",
  "style": "high_quality",
  "options": {
    "aspectRatio": "16:9",
    "characterPrompt": "<user-character-prompt>",
    "characterNegativePrompt": "",
    "motionId": 0,
    "parentMotionId": 0,
    "motionPrompt": "",
    "characterResultUuid": "<generated-character-uuid>",
    "characterDrivingMediaId": "<character-driving-media-id>",
    "characterGender": "male",
    "characterEthnicity": "",
    "characterAge": "adult",
    "characterStyle": "realistic",
    "characterBeard": "shaven",
    "backgroundResultUuid": "",
    "backgroundPrompt": "",
    "backgroundMediaId": 0,
    "audioSource": "library",
    "audioMediaId": "<trimmed-audio-media-id>",
    "audioVocalUrl": "",
    "characterImageMediaId": 0,
    "ttsText": "",
    "ttsLanguage": "en-US",
    "ttsVoice": "en-US-AndrewMultilingualNeural",
    "ttsVoiceGender": "",
    "ttsEmotion": "general",
    "ttsSpeed": 50,
    "ttsPitch": 50,
    "voiceCloneCategory": "cloned",
    "voiceCloneLanguage": 1,
    "voiceCloneVoice": null,
    "songPrompt": "",
    "songLyrics": "",
    "songLength": "short",
    "songStylesSelectedList": [],
    "songResultUuid": "",
    "audioResultUuid": "",
    "replicateMotionUseSource": true,
    "replicateUseVoiceChanger": false,
    "replicateMotionMode": "animate",
    "reverseVideoMode": true
  }
}
```

The numeric media IDs above are capture examples, not constants. The important relationship is `trim response.id -> project options.audioMediaId`.

### Sanitized initial response

HTTP 200:

```json
{
  "id": "<created-project-id>",
  "parentId": null,
  "title": "<project-title>",
  "user": "<account-object-redacted>",
  "userId": "<provider-user-id>",
  "createdDate": "2026-07-20T12:19:02+00:00",
  "updatedDate": "2026-07-20T12:19:02+00:00",
  "options": {
    "aspectRatio": "16:9",
    "characterPrompt": "<user-character-prompt>",
    "characterNegativePrompt": "",
    "motionId": 0,
    "motionPrompt": "",
    "characterResultUuid": "<generated-character-uuid>",
    "characterDrivingMediaId": "<character-driving-media-id>",
    "backgroundResultUuid": "",
    "backgroundMediaId": 0,
    "audioSource": "library",
    "audioMediaId": "<trimmed-audio-media-id>",
    "audioVocalUrl": "",
    "characterImageMediaId": 0,
    "characterAge": "adult",
    "characterGender": "male",
    "characterBeard": "shaven",
    "characterStyle": "realistic",
    "ttsText": "",
    "ttsLanguage": "en-US",
    "ttsVoice": "en-US-AndrewMultilingualNeural",
    "ttsVoiceGender": "",
    "ttsEmotion": "general",
    "ttsSpeed": 50,
    "ttsPitch": 50,
    "songPrompt": "",
    "songLyrics": "",
    "songLength": "short",
    "songStylesSelectedList": [],
    "songResultUuid": "",
    "audioResultUuid": "",
    "reverseVideoMode": true
  },
  "subtitlesOptions": [],
  "type": "human",
  "style": "high_quality",
  "status": "pending",
  "message": null,
  "taskUuid": "<provider-task-uuid>",
  "taskPrevUuid": null,
  "taskStepNumber": 0,
  "taskStepsTotal": 2,
  "previewMedia": "<generated-preview-object-redacted>",
  "media": null,
  "motionVideo": null
}
```

Initial project identity and state in the capture: project `<created-project-id>`, type `human`, style `high_quality`, status `pending`, step 0 of 2.

## Duration and merge contracts

`POST /project/video_duration_limit` is style-dependent: the captured High Quality limit is 60 seconds and the captured normal limit is 300 seconds. Source duration is probed locally; every segment is clamped to the returned limit and the final segment ends exactly at source duration. Trim responses are validated against the requested duration.

`app.talkingphotos.ai 2.har`, entry 5, confirms ordered merge submission:

```json
{
  "itemsIds": ["<merge-child-project-id-1>", "<merge-child-project-id-2>", "<merge-child-project-id-3>"],
  "title": "<merge-title>",
  "audioMediaId": 0
}
```

The HTTP 200 response starts project `<merge-result-project-id>` with `type="video_merge"` and `status="pending"`. `itemsIds` order is therefore part of the integration contract; automation sorts durable child jobs by `segmentOrdinal` before submission.

## TTS + WebSocket resolution (confirmed separately, sanitized)

`POST /text_to_speech/create_audio_vc` returns only `{ success, uuid, textValue }` — no media id. The frontend then opens `wss://ws.talkingphotos.ai/`, sends `{ "recipient_uuid": "<tts-result-uuid>", "message": "connected" }`, and treats a frame of the shape `{ media_id: <positive integer>, type: "audio", out_path: "<provider audio path>", code: 200, duration: <positive number> }` as the authoritative UUID -> media-ID resolution. One socket is opened per UUID (never shared/multiplexed) so concurrent TTS requests cannot cross-associate a result. The implementation never infers a result by scanning the Text-To-Speech library for the newest item.

## Implementation boundary

Uploaded-library-audio Human creation and TTS-based Human creation (custom script and transcript-reconstructed script) are both enabled, gated by the WebSocket resolution above. Voice cloning and unobserved project variants remain outside this write contract. Provider subtitle creation (`POST /project/subtitles/create`) uses a sanitized clone built from `GET /project/{id}`, never the raw account/user object.
