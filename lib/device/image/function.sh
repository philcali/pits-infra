#!/bin/bash

FRAMERATE=${FRAMERATE:-15}
CONVERSION_PATH=${CONVERSION_PATH:-motion_videos_converted}
CONVERSION_FORMAT=${CONVERSION_FORMAT:-mkv}

function handler() {
  EVENT_DATA=$1
  echo "Event data: $EVENT_DATA"
  VIDEO_URLS=$(echo "$EVENT_DATA" | jq '.Records[].s3 | "s3://" + .bucket.name + "/" + .object.key' | tr -d '"')

  for video_object in $VIDEO_URLS; do
    CAMERA_NAME=$(basename "$(dirname "$video_object")")
    VIDEO_FILE=$(basename "$video_object")
    VIDEO_PATH=$(basename "$(dirname "$(dirname "$video_object")")")
    BUCKET_NAME=$(echo "$video_object" | sed -E 's|^s3://([^/]+)/.+|\1|')
    TEMP_DIR=$(mktemp -d)
    TRIGGER=$(aws s3api head-object \
      --bucket "$BUCKET_NAME" \
      --key "$VIDEO_PATH/$CAMERA_NAME/$VIDEO_FILE" \
      --query 'Metadata."x-amzn-meta-trigger"' \
      --output text)
    aws s3 cp "$video_object" "$TEMP_DIR"
    NEW_VIDEO_FILE="${VIDEO_FILE%.*}.${CONVERSION_FORMAT}"
    ffmpeg -r "$FRAMERATE" -i "$TEMP_DIR/$VIDEO_FILE" -c copy "$TEMP_DIR/$NEW_VIDEO_FILE"
    DURATION=$(mediainfo --Output=JSON "$TEMP_DIR/$NEW_VIDEO_FILE" | jq '.media.track[] | select(.["@type"] == "General") | .Duration' | tr -d '"')
    aws s3 cp \
        "$TEMP_DIR/$NEW_VIDEO_FILE" \
        "s3://$BUCKET_NAME/$CONVERSION_PATH/$CAMERA_NAME/$NEW_VIDEO_FILE" \
        --metadata "{\"x-amzn-meta-duration\": \"$DURATION\", \"x-amzn-meta-trigger\": \"$TRIGGER\"}"
    rm -rf "$TEMP_DIR"
  done

  echo "Finished converting videos"
}
