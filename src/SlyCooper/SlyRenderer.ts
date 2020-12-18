import * as Viewer from '../viewer';
import { FakeTextureHolder } from '../TextureHolder';
import { GfxDevice, GfxRenderPass, GfxBindingLayoutDescriptor, GfxHostAccessPass, GfxMegaStateDescriptor, GfxCullMode, GfxFrontFaceMode, GfxBlendMode, GfxBlendFactor, GfxSampler, GfxWrapMode, GfxTexFilterMode, GfxMipFilterMode, GfxProgramDescriptorSimple } from "../gfx/platform/GfxPlatform";
import { preprocessProgramObj_GLSL } from "../gfx/shaderc/GfxShaderCompiler";
import { GfxRenderHelper } from "../gfx/render/GfxRenderGraph";
import { BasicRenderTarget, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderTargetHelpers";
import { GfxRenderInstManager, GfxRendererLayer, makeSortKeyOpaque } from "../gfx/render/GfxRenderer";
import { fillMatrix4x4, fillMatrix4x3, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers";
import { mat4, vec3, vec2, vec4 } from "gl-matrix";
import { computeViewMatrix, CameraController } from "../Camera";
import { nArray, assertExists } from "../util";
import { TextureMapping } from "../TextureHolder";
import { MathConstants, scaleMatrix } from "../MathHelpers";
import { AABB } from "../Geometry";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import * as Data from "./SlyData";

class SlyProgram {
    public static ub_SceneParams = 0;
    public static ub_ShapeParams = 1;

    public both = `
layout(row_major, std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
};

layout(row_major, std140) uniform ub_ShapeParams {
    Mat4x3 u_BoneMatrix[1];
};

// #define u_BaseDiffuse (u_Misc[0].x)
// #define u_BaseAmbient (u_Misc[0].y)

#define u_BaseDiffuse 1.0
#define u_BaseAmbient 0.2

// uniform sampler2D u_Texture[1];
`;

    public vert: string = `
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_TexCoord;

out vec3 v_Normal;
out vec2 v_TexCoord;

void main() {
    gl_Position = Mul(u_Projection, Mul(_Mat4x4(u_BoneMatrix[0]), vec4(a_Position, 1.0)));
    v_Normal = normalize(vec4(a_Normal, 0.0).xyz);

    // gl_Position = Mul(u_Projection, vec4(a_Position, 1.0));
    // v_Normal = normalize(vec4(a_Normal, 0.0).xyz);
    v_TexCoord = a_TexCoord.xy;
}
`;

    public frag: string = `
in vec2 v_TexCoord;
in vec3 v_Normal;

void main() {
    vec2 t_DiffuseTexCoord = mod(v_TexCoord, vec2(1.0, 1.0));

    // float t_LightFalloff = clamp(dot(u_LightDirection.xyz, v_Normal.xyz), 0.0, 1.0);
    // float t_Illum = clamp(t_LightFalloff + u_BaseAmbient, 0.0, 1.0);

    // gl_FragColor.rgb = t_Illum * t_DiffuseMapColor.rgb;
    // gl_FragColor.a = t_DiffuseMapColor.a;

    // gl_FragColor = vec4(t_DiffuseTexCoord, 0.0, 1.0);
    gl_FragColor = vec4(v_Normal, 1.0);
}
`;
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 0, },
];

const modelViewScratch = mat4.create();

// TODO: move?

export class SlyRenderer implements Viewer.SceneGfx {
    public textureHolder = new FakeTextureHolder([]);

    private program: GfxProgramDescriptorSimple;
    private renderTarget = new BasicRenderTarget();
    private renderHelper: GfxRenderHelper;
    private modelMatrix: mat4 = mat4.create();
    private meshRenderers: SlyMeshRenderer[] = [];

    constructor(device: GfxDevice, meshes: Data.Mesh[], textures: Data.Texture[]) {
        this.renderHelper = new GfxRenderHelper(device);
        this.program = preprocessProgramObj_GLSL(device, new SlyProgram());
        console.log(this.program);

        mat4.fromScaling(this.modelMatrix, [1 / 100, 1 / 100, 1 / 100]);

        const gfxCache = this.renderHelper.getCache();

        for (let mesh of meshes) {
            for (let meshChunk of mesh.chunks) {
                const chunkGeometryData = new GeometryData(device, gfxCache, meshChunk);
                const meshRenderer = new SlyMeshRenderer(chunkGeometryData);
                this.meshRenderers.push(meshRenderer);
            }
        }
    }

    public prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput, renderInstManager: GfxRenderInstManager) {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        const gfxProgram = renderInstManager.gfxRenderCache.createProgramSimple(device, this.program);
        template.setGfxProgram(gfxProgram);

        let offs = template.allocateUniformBuffer(SlyProgram.ub_SceneParams, 16);
        const d = template.mapUniformBufferF32(SlyProgram.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, viewerInput.camera.projectionMatrix);

        for (let meshRenderer of this.meshRenderers) {
            meshRenderer.prepareToRender(renderInstManager, viewerInput);
        }

        renderInstManager.popTemplateRenderInst();

        this.renderHelper.prepareToRender(device, hostAccessPass);
    }

    public render(device: GfxDevice, renderInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        const renderInstManager = this.renderHelper.renderInstManager;

        this.prepareToRender(device, hostAccessPass, renderInput, renderInstManager);
        device.submitPass(hostAccessPass);

        this.renderTarget.setParameters(device, renderInput.backbufferWidth, renderInput.backbufferHeight);
        const passRenderer = this.renderTarget.createRenderPass(device, renderInput.viewport, standardFullClearRenderPassDescriptor);
        renderInstManager.drawOnPassRenderer(device, passRenderer);
        renderInstManager.resetRenderInsts();
        return passRenderer;
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy(device);
        this.renderTarget.destroy(device);
    }
}

import { GfxBuffer, GfxInputLayout, GfxInputState, GfxBufferUsage, GfxVertexAttributeDescriptor, GfxFormat, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency } from "../gfx/platform/GfxPlatform";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";

export interface VertexAttributes {
    position: vec3;
    normal: vec3;
    texcoord: vec2;
}

export interface IndexedPrimitives<T> {
    vertices: T[];
    indices: number[];
}

export class GeometryData {
    private indexBuffer: GfxBuffer;
    private positionBuffer: GfxBuffer;
    private normalBuffer: GfxBuffer;
    private texcoordBuffer: GfxBuffer;
    public indexCount: number;
    public inputLayout: GfxInputLayout;
    public inputState: GfxInputState;

    // constructor(device: GfxDevice, cache: GfxRenderCache, geometry: Sly_ShaderInstancedIndexedPrimitives<Sly_VertexPositionNormalTextureInstance>) {
    // constructor(device: GfxDevice, cache: GfxRenderCache, geometry: IndexedPrimitives<VertexAttributes>) {
    constructor(device: GfxDevice, cache: GfxRenderCache, meshChunk: Data.MeshChunk) {

        const indices = Uint16Array.from(meshChunk.trianglesIndices);
        this.indexCount = indices.length;
        this.positionBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, meshChunk.positions.buffer);
        this.normalBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, meshChunk.normals.buffer);
        this.texcoordBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, meshChunk.texCoords.buffer);
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.INDEX, meshChunk.trianglesIndices.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Position
            { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Normal
            { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG,  bufferByteOffset: 0, }, // TexCoord
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 2*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
        ];
        this.inputLayout = cache.createInputLayout(device, {
            indexBufferFormat: GfxFormat.U16_R,
            vertexAttributeDescriptors,
            vertexBufferDescriptors,
        });
        this.inputState = device.createInputState(this.inputLayout, [
            { buffer: this.positionBuffer, byteOffset: 0, },
            { buffer: this.normalBuffer, byteOffset: 0, },
            { buffer: this.texcoordBuffer, byteOffset: 0, },
        ],
        { buffer: this.indexBuffer, byteOffset: 0 });
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.indexBuffer);
        device.destroyBuffer(this.positionBuffer);
        device.destroyBuffer(this.normalBuffer);
        device.destroyBuffer(this.texcoordBuffer);
        device.destroyInputState(this.inputState);
    }
}

const textureMappingScratch = nArray(2, () => new TextureMapping());
export class SlyMeshRenderer {
    public modelMatrix = mat4.create();
    public textureMatrix = mat4.create();
    private textureMapping = new TextureMapping();
    private megaStateFlags: Partial<GfxMegaStateDescriptor> = {};

    // constructor(textureData: (ArtObjectData | TrilesetData), private geometryData: GeometryData) {
    constructor(private geometryData: GeometryData) {
        // this.textureMapping.gfxTexture = textureData.texture;
        // this.textureMapping.gfxSampler = textureData.sampler;

        this.megaStateFlags.frontFace = GfxFrontFaceMode.CW;
        // this.megaStateFlags.cullMode = GfxCullMode.BACK;
        this.megaStateFlags.cullMode = GfxCullMode.NONE;

        mat4.fromXRotation(this.modelMatrix, 3 * 90 * MathConstants.DEG_TO_RAD);
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setInputLayoutAndState(this.geometryData.inputLayout, this.geometryData.inputState);
        // textureMappingScratch[0].copy(this.textureMapping);
        renderInst.setSamplerBindingsFromTextureMappings(textureMappingScratch);
        renderInst.setMegaStateFlags(this.megaStateFlags);

        let offs = renderInst.allocateUniformBuffer(SlyProgram.ub_ShapeParams, 12);
        const d = renderInst.mapUniformBufferF32(SlyProgram.ub_ShapeParams);
        computeViewMatrix(modelViewScratch, viewerInput.camera);
        mat4.mul(modelViewScratch, modelViewScratch, this.modelMatrix);
        offs += fillMatrix4x3(d, offs, modelViewScratch);
        // offs += fillVec4v(d, offs, levelRenderData.lightDirection);
        // offs += fillVec4(d, offs, 1, 1, 0, 0);
        // offs += fillVec4(d, offs, 1, 1, 0, 0);
        // offs += fillVec4v(d, offs, levelRenderData.shadowTexScaleBias);
        // offs += fillVec4(d, offs, levelRenderData.baseDiffuse, levelRenderData.baseAmbient, 0, 0);

        renderInst.drawIndexes(this.geometryData.indexCount);
        // console.log(this.geometryData.indexCount);
        renderInstManager.submitRenderInst(renderInst);
    }
}
