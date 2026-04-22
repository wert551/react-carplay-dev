interface Navigator {
  readonly usb?: USB
  readonly gpu?: GPU
}

interface USB {
  onconnect: ((event: Event) => void | Promise<void>) | null
  ondisconnect: ((event: Event) => void | Promise<void>) | null
}

interface OffscreenCanvas {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null
}

type GPUTextureFormat = string

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>
  getPreferredCanvasFormat(): GPUTextureFormat
}

interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>
}

interface GPUDevice {
  readonly queue: GPUQueue
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup
  createCommandEncoder(): GPUCommandEncoder
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline
  createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule
  importExternalTexture(descriptor: GPUExternalTextureDescriptor): GPUExternalTexture
}

interface GPUQueue {
  submit(commandBuffers: GPUCommandBuffer[]): void
}

interface GPUCanvasContext {
  configure(configuration: GPUCanvasConfiguration): void
  getCurrentTexture(): GPUTexture
}

interface GPUCanvasConfiguration {
  device: GPUDevice
  format: GPUTextureFormat
  alphaMode?: 'opaque' | 'premultiplied'
}

interface GPUTexture {
  createView(): GPUTextureView
}

interface GPUTextureView {}
interface GPUCommandBuffer {}
interface GPUSampler {}
interface GPUShaderModule {}
interface GPUBindGroup {}
interface GPUExternalTexture {}
interface GPUSamplerDescriptor {}

interface GPUShaderModuleDescriptor {
  code: string
}

interface GPUExternalTextureDescriptor {
  source: VideoFrame
}

interface GPUBindGroupDescriptor {
  layout: GPUBindGroupLayout
  entries: GPUBindGroupEntry[]
}

interface GPUBindGroupEntry {
  binding: number
  resource: GPUSampler | GPUExternalTexture
}

interface GPUBindGroupLayout {}

interface GPURenderPipeline {
  getBindGroupLayout(index: number): GPUBindGroupLayout
}

interface GPURenderPipelineDescriptor {
  layout: 'auto'
  vertex: {
    module: GPUShaderModule
    entryPoint: string
  }
  fragment: {
    module: GPUShaderModule
    entryPoint: string
    targets: Array<{ format: GPUTextureFormat }>
  }
  primitive: {
    topology: 'triangle-list'
  }
}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder
  finish(): GPUCommandBuffer
}

interface GPURenderPassDescriptor {
  colorAttachments: Array<{
    view: GPUTextureView
    clearValue: [number, number, number, number]
    loadOp: 'clear' | 'load'
    storeOp: 'store' | 'discard'
  }>
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void
  setBindGroup(index: number, bindGroup: GPUBindGroup): void
  draw(vertexCount: number, instanceCount: number, firstVertex: number, firstInstance: number): void
  end(): void
}
