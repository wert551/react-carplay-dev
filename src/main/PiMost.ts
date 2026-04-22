import { SocketMost, SocketMostClient } from 'socketmost'
import { Stream } from "socketmost/dist/modules/Messages";
import { RuntimeControl } from './RuntimeControl'

export class PiMost {
  socketMost: SocketMost
  socketMostClient: SocketMostClient
  control: RuntimeControl
  constructor(control: RuntimeControl) {
    console.log("creating client in PiMost")
    this.socketMost = new SocketMost()
    this.socketMostClient = new SocketMostClient()
    this.control = control

    this.control.on('stream', (stream) => {
      this.stream(stream)
    })
  }

  stream(stream: Stream) {
    this.socketMostClient.stream(stream)
  }
}


