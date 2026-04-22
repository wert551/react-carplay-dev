import { useEffect, useRef, useState } from "react";
import {Typography} from "@mui/material";
import type { ExtraConfig } from "../../../shared/config";

type CameraProps = {
  settings: ExtraConfig | null
}

const Camera = ({settings}: CameraProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraFound, setCameraFound] = useState(false)
  console.log(settings)

  useEffect(() => {
    if(!settings) return
    getVideo(settings);
  }, [videoRef, settings]);

  const getVideo = (activeSettings: ExtraConfig) => {
    navigator.mediaDevices
      .getUserMedia({ video: { width: 800, deviceId: activeSettings.camera} })
      .then((stream) => {
        console.log(stream)
        setCameraFound(true)
        let video = videoRef.current!;
        video.srcObject = stream;
        video.play();
      })
      .catch((err: unknown) => {
        console.error("error:", err);
      });
  };

  return (
    <div >
      <div >
          <video ref={videoRef} style={{maxWidth: '100%', height: 'auto'}}/>
        {cameraFound ? null : <Typography>No Camera Found</Typography>}
      </div>
    </div>
  );
};

export default Camera;
