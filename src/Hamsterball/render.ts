import { vec3 } from 'gl-matrix';

import { DeviceProgram } from '../Program';
import * as Viewer from '../viewer';
import * as UI from '../ui';

import { GfxDevice, GfxBufferUsage, GfxBuffer, GfxInputState, GfxFormat, GfxInputLayout, GfxProgram, GfxBindingLayoutDescriptor, GfxRenderPass, GfxBindings, GfxVertexBufferFrequency, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxCullMode } from '../gfx/platform/GfxPlatform';
import { fillColor, fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers';
import { makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager';
import { CameraController } from '../Camera';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph';
import { Red } from '../Color';
import { MeshWorld, VertexData } from './bin';

class HamsterballProgram extends DeviceProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_Texcoord = 2;
    public static a_MaterialId = 3;

    public static ub_SceneParams = 0;
    public static ub_ObjectParams = 1;

    public override both = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
};

layout(std140) uniform ub_ObjectParams {
    vec4 u_Color;
};

varying vec2 v_LightIntensity;
varying vec3 v_MaterialColor;

#ifdef VERT
layout(location = ${HamsterballProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${HamsterballProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${HamsterballProgram.a_Texcoord}) attribute vec2 a_Texcoord;
layout(location = ${HamsterballProgram.a_MaterialId}) attribute uint a_MaterialId;

void mainVS() {
    const float t_ModelScale = 1.0;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position * t_ModelScale, 1.0)));
    vec3 t_LightDirection = normalize(vec3(.2, -1, .5));
    float t_LightIntensityF = dot(-a_Normal, t_LightDirection);
    float t_LightIntensityB = dot( a_Normal, t_LightDirection);
    v_LightIntensity = vec2(t_LightIntensityF, t_LightIntensityB);
    v_MaterialColor = vec3(float(a_MaterialId >> 16) / 255.0);
}
#endif

#ifdef FRAG
void mainPS() {
    float t_LightIntensity = gl_FrontFacing ? v_LightIntensity.x : v_LightIntensity.y;
    float t_LightTint = 0.3 * t_LightIntensity;
    gl_FragColor = u_Color + vec4(t_LightTint, t_LightTint, t_LightTint, 0.0) * vec4(v_MaterialColor, 1.0);
    // gl_FragColor = vec4(0, 1, 0, 1);
}
#endif
`;
}

class Chunk {
    public numVertices: number;
    public posBuffer: GfxBuffer;
    public nrmBuffer: GfxBuffer;
    public texcoordsBuffer: GfxBuffer;
    public materialIdBuffer: GfxBuffer;

    public numIndices: number;
    public indexBuffer: GfxBuffer;

    public inputState: GfxInputState;

    constructor(device: GfxDevice, public vertexData: VertexData, public indexData: Uint16Array, private inputLayout: GfxInputLayout) {
        this.posBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.positions.buffer);
        this.nrmBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.normals.buffer);
        this.texcoordsBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.texcoords.buffer);
        this.materialIdBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.materialIds.buffer);

        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, indexData.buffer);
        this.numIndices = indexData.length;

        this.inputState = device.createInputState(inputLayout, [
            { buffer: this.posBuffer, byteOffset: 0, },
            { buffer: this.nrmBuffer, byteOffset: 0, },
            { buffer: this.texcoordsBuffer, byteOffset: 0, },
            { buffer: this.materialIdBuffer, byteOffset: 0, },
        ],
        { buffer: this.indexBuffer, byteOffset: 0 });

        this.numVertices = vertexData.positions.length;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager): void {
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.drawIndexes(this.numIndices);
        renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.posBuffer);
        device.destroyBuffer(this.nrmBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyBuffer(this.texcoordsBuffer);
        device.destroyBuffer(this.materialIdBuffer);
        device.destroyInputState(this.inputState);
    }
}

export class HamsterballRenderer {
    public visible: boolean = true;
    public name: string;

    private chunk: Chunk;

    constructor(device: GfxDevice, public meshWorld: MeshWorld, inputLayout: GfxInputLayout) {
        this.name = "dummy";

        this.chunk = new Chunk(device, meshWorld.vertexData, meshWorld.indexData, inputLayout);
    }

    public setVisible(v: boolean) {
        this.visible = v;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager): void {
        if (!this.visible)
            return;

        const templateRenderInst = renderInstManager.pushTemplateRenderInst();

        let offs = templateRenderInst.allocateUniformBuffer(HamsterballProgram.ub_ObjectParams, 4);
        const d = templateRenderInst.mapUniformBufferF32(HamsterballProgram.ub_ObjectParams);
        offs += fillColor(d, offs, Red);

        // for (let i = 0; i < this.chunks.length; i++)
            // this.chunks[i].prepareToRender(renderInstManager);
        this.chunk.prepareToRender(renderInstManager);

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        // this.chunks.forEach((chunk) => chunk.destroy(device));
        this.chunk.destroy(device);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 0 }, // ub_SceneParams
];

export class Scene implements Viewer.SceneGfx {
    private inputLayout: GfxInputLayout;
    private program: GfxProgram;
    private hamsterballRenderers: HamsterballRenderer[] = [];
    private renderHelper: GfxRenderHelper;

    constructor(device: GfxDevice, public meshworld: MeshWorld) {
        this.program = device.createProgram(new HamsterballProgram());

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: HamsterballProgram.a_Position,   bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
            { location: HamsterballProgram.a_Normal,     bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
            { location: HamsterballProgram.a_Texcoord,   bufferIndex: 2, bufferByteOffset: 0, format: GfxFormat.F32_RG, },
            { location: HamsterballProgram.a_MaterialId, bufferIndex: 3, bufferByteOffset: 0, format: GfxFormat.U32_R, },
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 2*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 1*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
        ];
        const indexBufferFormat = GfxFormat.U16_R;
        this.inputLayout = device.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

        // this.HamsterballRenderers = this.ivs.map((iv) => {
        //     return new HamsterballRenderer(device, iv, this.inputLayout);
        // });
        this.hamsterballRenderers.push(new HamsterballRenderer(device, meshworld, this.inputLayout));

        this.renderHelper = new GfxRenderHelper(device);
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(16/60);
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        template.setGfxProgram(this.program);
        template.setMegaStateFlags({ cullMode: GfxCullMode.Back });

        let offs = template.allocateUniformBuffer(HamsterballProgram.ub_SceneParams, 32);
        const mapped = template.mapUniformBufferF32(HamsterballProgram.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.viewMatrix);

        for (let i = 0; i < this.hamsterballRenderers.length; i++)
            this.hamsterballRenderers[i].prepareToRender(this.renderHelper.renderInstManager);

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
    }

    public destroy(device: GfxDevice): void {
        device.destroyInputLayout(this.inputLayout);
        device.destroyProgram(this.program);
        this.hamsterballRenderers.forEach((r) => r.destroy(device));
        this.renderHelper.destroy();
    }

    public createPanels(): UI.Panel[] {
        const layersPanel = new UI.LayerPanel();
        layersPanel.setLayers(this.hamsterballRenderers);
        return [layersPanel];
    }
}
