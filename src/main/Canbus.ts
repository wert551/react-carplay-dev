// import {Message} from "*can.node";
import * as can from "socketcan";
import EventEmitter from 'events'
import { CanConfig } from "./Globals";
import { Socket } from "./Socket";

type CanMask = {
  id: number,
  mask: number,
  invert: boolean
}

type CanChannel = ReturnType<typeof can.createRawChannel>
type CanFrame = {
  id: number,
  data: ArrayLike<number>
}

export class Canbus extends EventEmitter {
  channel: CanChannel
  canChannel: string
  subscriptions: CanConfig
  masks: CanMask[]
  reverse: boolean
  lights: boolean
  socket: Socket
  constructor(canChannel: string, socket: Socket, subscriptions: CanConfig = {}) {
    super();
    this.canChannel = canChannel
    this.subscriptions = subscriptions
    this.channel = can.createRawChannel(this.canChannel)
    this.masks = []
    this.reverse = false
    this.lights = false
    this.socket = socket
    ;(Object.keys(this.subscriptions) as Array<keyof CanConfig>).forEach((sub) => {
      const subscription = this.subscriptions[sub]
      if(subscription) {
        this.masks.push({id: subscription.canId, mask: subscription.canId, invert: false})
      }
    })
    console.log(this.masks)
    this.channel.setRxFilters(this.masks)

    this.channel.addListener("onMessage", (msg: CanFrame) => {
      let data
      switch (msg.id) {
        case this.subscriptions?.reverse?.canId:
          if (!this.subscriptions.reverse) {
            break
          }
          data = msg.data[this.subscriptions.reverse.byte] & this.subscriptions.reverse.mask
          console.log("reverse", data)
          let tempReverse
          if (data) {
            tempReverse = true
          } else {
            tempReverse = false
          }
          if(tempReverse !== this.reverse) {
            this.socket.sendReverse(tempReverse)
            this.reverse = tempReverse
          }
          break
        case this.subscriptions?.lights?.canId:
          if (!this.subscriptions.lights) {
            break
          }
          let tempLights = this.lights
          data = msg.data[this.subscriptions.lights.byte] & this.subscriptions.lights.mask
          if (data) {
            tempLights = true
          } else {
            tempLights = false
          }
          if(tempLights !== this.lights) {
            this.socket.sendLights(tempLights)
            this.lights = tempLights
          }
          break
      }
    })

    this.channel.start()

  }
}
