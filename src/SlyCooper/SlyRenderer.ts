import * as Viewer from '../viewer';
import * as UI from '../ui';
import { FakeTextureHolder } from '../TextureHolder';
import { GfxDevice, GfxRenderPass, GfxBindingLayoutDescriptor, GfxHostAccessPass, GfxMegaStateDescriptor, GfxCullMode, GfxFrontFaceMode, GfxBlendMode, GfxBlendFactor, GfxSampler, GfxTexture, GfxWrapMode, GfxTexFilterMode, GfxMipFilterMode, GfxProgramDescriptorSimple, makeTextureDescriptor2D, GfxColor } from "../gfx/platform/GfxPlatform";
import { preprocessProgramObj_GLSL, DefineMap } from "../gfx/shaderc/GfxShaderCompiler";
import { GfxRenderHelper } from "../gfx/render/GfxRenderGraph";
import { BasicRenderTarget, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderTargetHelpers";
import { GfxRenderInstManager, GfxRendererLayer, makeSortKey, makeSortKeyOpaque } from "../gfx/render/GfxRenderer";
import { fillVec2v, fillMatrix4x4, fillMatrix4x3, fillVec4, fillVec4v, fillColor } from "../gfx/helpers/UniformBufferHelpers";
import { mat4, vec3, vec2, vec4 } from "gl-matrix";
import { computeViewMatrix, CameraController, computeViewMatrixSkybox } from "../Camera";
import { nArray, assertExists, hexzero0x, hexzero, binzero, binzero0b } from "../util";
import { TextureMapping } from "../TextureHolder";
import { MathConstants, scaleMatrix } from "../MathHelpers";
import { AABB } from "../Geometry";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import * as Data from "./SlyData";
import * as Settings from './SlyConstants';
import { drawWorldSpaceAABB, getDebugOverlayCanvas2D, drawWorldSpacePoint } from "../DebugJunk";
import { Color, Magenta, colorToCSS, Red, Green, Blue, Cyan } from "../Color";
import { GfxBuffer, GfxInputLayout, GfxInputState, GfxBufferUsage, GfxVertexAttributeDescriptor, GfxFormat, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency } from "../gfx/platform/GfxPlatform";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";

class SlyRenderHacks {
    disableTextures = false;
    disableVertexColors = false;
    disableAmbientLighting = true;
    disableTextureColor = true;
    disableMeshInstances = false;
}

class SlyDebugHacks {
    drawMeshOrigins = false;
    drawSzmsPositions = false;
    drawSzmePositions = false;
}

let renderHacks = new SlyRenderHacks();
let debugHacks = new SlyDebugHacks();

class SlyProgram {
    public static ub_SceneParams = 0;
    public static ub_ShapeParams = 1;

    public both = `
layout(row_major, std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    float u_Time;
};

layout(row_major, std140) uniform ub_ShapeParams {
    Mat4x4 u_BoneMatrix[1];
    vec4 u_TextureColor1;
    vec4 u_TextureColor2;
    vec2 u_TexOffset;
};

// #define u_BaseDiffuse (u_Misc[0].x)
// #define u_BaseAmbient (u_Misc[0].y)

#define u_BaseDiffuse 1.0
#define u_BaseAmbient 0.2

uniform sampler2D u_Texture[3];

// todo use these
#define u_DiffuseTexture SAMPLER_2D(u_Texture[0])
#define u_AmbientTexture SAMPLER_2D(u_Texture[1])
#define u_UnkTexture SAMPLER_2D(u_Texture[2])
`;

    public vert: string = `
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_TexCoord;
layout(location = 3) in vec4 a_VertexColor;

out vec3 v_Normal;
out vec2 v_TexCoord;
out vec3 v_VertexColor;

void main() {
    gl_Position = Mul(u_Projection, Mul(u_BoneMatrix[0], vec4(a_Position, 1.0)));
    v_Normal = normalize(vec4(a_Normal, 0.0).xyz);

    // gl_Position = Mul(u_Projection, vec4(a_Position, 1.0));
    // v_Normal = normalize(vec4(a_Normal, 0.0).xyz);
    v_TexCoord = a_TexCoord.xy;
    v_VertexColor = a_VertexColor.rgb;
}
`;

    public frag: string = `
in vec2 v_TexCoord;
in vec3 v_Normal;
in vec3 v_VertexColor;
in vec3 v_VertexColor2;

void main() {
    vec2 t_TexCoord = mod(v_TexCoord + u_TexOffset, vec2(1.0));
    // vec2 t_TexCoord = v_TexCoord;
    // gl_FragColor = vec4(t_TexCoord, 0.0, 1.0); return;

#if ENABLE_TEXTURES
    vec3 t_DiffuseMapColor = texture(u_DiffuseTexture, t_TexCoord.xy).rgb;
    vec4 t_AmbientMapColor = texture(u_AmbientTexture, t_TexCoord.xy);
    vec3 t_UnkMapColor = texture(u_UnkTexture, t_TexCoord.xy).rgb;
#else
    vec3 t_DiffuseMapColor = vec3(1.0);
    vec4 t_AmbientMapColor = vec4(0.0, 0.0, 0.0, texture(u_AmbientTexture, t_TexCoord.xy).a);
    vec3 t_UnkMapColor = vec3(1.0);
#endif

    // float t_LightFalloff = clamp(dot(u_LightDirection.xyz, v_Normal.xyz), 0.0, 1.0);
    // float t_Illum = clamp(t_LightFalloff + u_BaseAmbient, 0.0, 1.0);

    // gl_FragColor.rgb = t_Illum * t_DiffuseMapColor.rgb;
    // gl_FragColor.a = t_DiffuseMapColor.a;

    // gl_FragColor = vec4(t_TexCoord, 0.0, 1.0);

    // gl_FragColor = vec4(v_Normal, 1.0);

#if ENABLE_VERTEX_COLORS
    vec3 vertexColor = v_VertexColor;
#else
    vec3 vertexColor = vec3(1.0);
#endif

    float vertexLighting = 0.22;
    vec4 inv_lit = vec4(0.105, 0.105, 0.105, 0.501);
    float tc1_w = 0.5;

    vec3 diffuseFinal = t_DiffuseMapColor * vertexColor * vertexLighting;
#if ENABLE_TEXTURE_COLOR
    diffuseFinal *= u_TextureColor1.rgb;
#endif

#if ENABLE_AMBIENT_LIGHTING
    vec3 lightDirection = normalize(vec3(0.1027, 0.02917, 0.267));
    vec3 lightColor = vec3(10./255., 23./255., 26./255.) * 1.0;
    float ambientLambert = clamp(max(dot(v_Normal.xyz, lightDirection), 0.0), 0.0, 1.0);
    vec3 ambientColor = lightColor * ambientLambert;

    vec3 ambientFinal = t_UnkMapColor.rgb * ambientColor;
    vec3 unkFinal = (inv_lit.rgb * t_AmbientMapColor.rgb + diffuseFinal) / 2.0;
#else
    vec3 ambientFinal = vec3(0.0);
    vec3 unkFinal = diffuseFinal;
#endif


    gl_FragColor.a = t_AmbientMapColor.a;
    gl_FragColor.a *= inv_lit.w * 4.;

    // TODO: implement more properly
    // if (gl_FragColor.a == 0.0)
        // discard;

    gl_FragColor.rgb = (ambientFinal * tc1_w + unkFinal) * 4.0; // * u_TextureColor1.rgb;

// #if ENABLE_TEXTURE_COLOR
//     // gl_FragColor.rgb *= u_TextureColor1.rgb;
//     gl_FragColor.rgb = u_TextureColor1.rgb;
// #endif
}
`;

    public defines: DefineMap = new Map<string, string>();

    constructor(renderHacks: SlyRenderHacks) {
        let boolToStr = (value: boolean) => {
            return value ? "0" : "1";
        };

        this.defines.set("ENABLE_TEXTURES", boolToStr(renderHacks.disableTextures));
        this.defines.set("ENABLE_VERTEX_COLORS", boolToStr(renderHacks.disableVertexColors));
        this.defines.set("ENABLE_AMBIENT_LIGHTING", boolToStr(renderHacks.disableAmbientLighting));
        this.defines.set("ENABLE_TEXTURE_COLOR", boolToStr(renderHacks.disableTextureColor));
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 3, },
];

export class SlyRenderer implements Viewer.SceneGfx {
    public textureHolder = new FakeTextureHolder([]);

    private program: (GfxProgramDescriptorSimple | null) = null;
    private renderTarget = new BasicRenderTarget();
    private renderHelper: GfxRenderHelper;
    private modelMatrix: mat4 = mat4.create();
    private meshRenderers: SlyMeshRenderer[] = [];
    private meshRenderersReverse: SlyMeshRenderer[] = [];

    private flagLayers: FlagLayer[] = [];

    private createShader(device: GfxDevice) {
        this.program = preprocessProgramObj_GLSL(device, new SlyProgram(renderHacks));
    }

    constructor(device: GfxDevice, meshContainers: Data.MeshContainer[], texturesDiffuse: (Data.Texture | null)[], texturesAmbient: (Data.Texture | null)[], texturesUnk: (Data.Texture | null)[], textureEntries: Data.TextureEntry[]) {
        this.renderHelper = new GfxRenderHelper(device);

        const gfxCache = this.renderHelper.getCache();

        for (let meshContainer of meshContainers) {
            let meshInstancesMap = new Map<number, Data.Mesh[]>();

            for (let mesh of meshContainer.meshes) {
                for (let meshInstance of mesh.instances) {
                    const instanceMeshIndex = meshInstance.instanceMeshIndex;

                    let meshInstances: Data.Mesh[];
                    if (meshInstancesMap.has(instanceMeshIndex))
                        meshInstances = meshInstancesMap.get(instanceMeshIndex)!;
                    else
                        meshInstances = [];

                    meshInstances.push(meshInstance);
                    meshInstancesMap.set(instanceMeshIndex, meshInstances);
                }
            }

            for (let mesh of meshContainer.meshes) {
                for (let meshChunk of mesh.chunks) {
                    const geometryData = new GeometryData(device, gfxCache, meshChunk);

                    let isFullyOpaque = true;

                    let textureData: (TextureData | null)[] = nArray(3, () => null);
                    let textureEntry: (Data.TextureEntry | null) = null;
                    if (meshChunk.szme) {
                        const texIndex = meshChunk.szme.texIndex;
                        const textureDiffuse = texturesDiffuse[texIndex];
                        if (textureDiffuse) {
                            // console.log(`mesh at ${hexzero0x(mesh.offset)} gets Diffuse texID ${hexzero0x(texIndex)}`);
                            textureData[0] = new TextureData(device, gfxCache, textureDiffuse)

                            const textureAmbient = texturesAmbient[texIndex];
                            if (textureAmbient) {
                                // console.log(`mesh at ${hexzero0x(mesh.offset)} gets Ambient texID ${hexzero0x(texIndex)}`);
                                textureData[1] = new TextureData(device, gfxCache, textureAmbient)
                            }
                            const textureUnk = texturesUnk[texIndex];
                            if (textureUnk) {
                                // console.log(`mesh at ${hexzero0x(mesh.offset)} gets Unk texID ${hexzero0x(texIndex)}`);
                                textureData[2] = new TextureData(device, gfxCache, textureUnk)
                            }

                            isFullyOpaque = textureDiffuse.isFullyOpaque;
                        }

                        textureEntry = textureEntries[texIndex];
                    }

                    const meshInstances = meshInstancesMap.get(mesh.meshIndex);
                    const meshRenderer = new SlyMeshRenderer(textureData, geometryData, meshChunk, textureEntry, isFullyOpaque, meshInstances);
                    meshRenderer.setVisible(isDefaultFlag(meshChunk.flags));
                    this.meshRenderers.push(meshRenderer);
                }
            }
            // this.meshRenderersReverse = this.meshRenderers.slice().reverse();
        }
    }

    public prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput, renderInstManager: GfxRenderInstManager) {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        if (!this.program)
            this.createShader(device);
        const gfxProgram = renderInstManager.gfxRenderCache.createProgramSimple(device, this.program!);
        template.setGfxProgram(gfxProgram);

        let offs = template.allocateUniformBuffer(SlyProgram.ub_SceneParams, 16 + 1);
        const d = template.mapUniformBufferF32(SlyProgram.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, viewerInput.camera.projectionMatrix);
        d[offs++] = viewerInput.time / 10000.0;

        for (let meshRenderer of this.meshRenderers) {
            meshRenderer.prepareToRender(renderInstManager, viewerInput);
        }
        // for (let meshRenderer of this.meshRenderersReverse) {
        //     meshRenderer.prepareToRender(renderInstManager, viewerInput);
        // }

        renderInstManager.popTemplateRenderInst();

        this.renderHelper.prepareToRender(device, hostAccessPass);
    }

    public render(device: GfxDevice, renderInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        const renderInstManager = this.renderHelper.renderInstManager;

        this.prepareToRender(device, hostAccessPass, renderInput, renderInstManager);
        device.submitPass(hostAccessPass);

        this.renderTarget.setParameters(device, renderInput.backbufferWidth, renderInput.backbufferHeight);
        const passRenderer = this.renderTarget.createRenderPass(device, renderInput.viewport, opaqueBlackFullClearRenderPassDescriptor);
        renderInstManager.drawOnPassRenderer(device, passRenderer);
        renderInstManager.resetRenderInsts();

        if (debugHacks.drawMeshOrigins || debugHacks.drawSzmsPositions || debugHacks.drawSzmePositions) {
            const ctx = getDebugOverlayCanvas2D();

            for (let meshRenderer of this.meshRenderers) {
                if (debugHacks.drawSzmsPositions) {
                    let posVec = meshRenderer.meshChunk.positions;
                    for (let i = 0; i < posVec.length; i += 3) {
                        const p = vec3.fromValues(posVec[i + 0], posVec[i + 2], -posVec[i + 1]);
                        drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 5);
                    }
                }

                if (meshRenderer.meshChunk.szme) {
                    if (debugHacks.drawMeshOrigins) {
                        let origin = meshRenderer.meshChunk.szme?.origin;
                        let originVec = vec3.fromValues(origin[0], origin[2], -origin[1]);
                        drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, originVec, Green, 9);
                    }

                    if (debugHacks.drawSzmePositions) {
                        let posVec = meshRenderer.meshChunk.szme.positions;
                        for (let i = 0; i < posVec.length; i += 3) {
                            const p = vec3.fromValues(posVec[i + 0], posVec[i + 2], -posVec[i + 1]);
                            drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 7);

                        }
                    }
                }
            }
        }

        // let aabb = new AABB(-1000, -5000, -1000, 100, 5000, 100);
        // const ctx = getDebugOverlayCanvas2D();
        // drawWorldSpaceAABB(ctx, renderInput.camera.clipFromWorldMatrix, aabb);

        // const dbgPos = this.meshRenderers[148].meshChunk.szme?.positions!;
        // for (let i = 0; i < dbgPos.length; i += 3) {
        //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
        //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 50);
        //     // console.log(`${p}`);
        // }
        // dbgPos = this.meshRenderers[148].meshChunk.positions!;
        // for (let i = 0; i < dbgPos.length; i += 3) {
        //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
        //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 20);
        //     // console.log(`${p}`);
        // }

        // for (let meshRenderer of this.meshRenderers) {
        // let dbgPos = meshRenderer.meshChunk.positions;
        // for (let i = 0; i < dbgPos.length; i += 3) {
        //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
        //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 13);
        // }

        // if (meshRenderer.meshChunk.szme) {
        // let orig = meshRenderer.meshChunk.szme?.origin;
        // let dbgPos = vec3.fromValues(orig[0], orig[2], -orig[1]);
        // drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, dbgPos, Green, 7);

        // dbgPos = meshRenderer.meshChunk.szme.positions;
        // for (let i = 0; i < dbgPos.length; i += 3) {
        //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
        //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 4);

        // }
        // }
        // }

        return passRenderer;
    }

    private setTexturesEnabled(enabled: boolean) {
        renderHacks.disableTextures = !enabled;
        this.program = null;
    }

    private setVertexColorsEnabled(enabled: boolean) {
        renderHacks.disableVertexColors = !enabled;
        this.program = null;
    }

    private setAmbientLightingEnabled(enabled: boolean) {
        renderHacks.disableAmbientLighting = !enabled;
        this.program = null;
    }

    private setTextureColorEnabled(enabled: boolean) {
        renderHacks.disableTextureColor = !enabled;
        this.program = null;
    }

    private setMeshInstancesEnabled(enabled: boolean) {
        renderHacks.disableMeshInstances = !enabled;
        this.program = null;
    }

    public createPanels(): UI.Panel[] {
        const panels: UI.Panel[] = [];

        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');

        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', !renderHacks.disableVertexColors);
        enableVertexColorsCheckbox.onchanged = () => {
            this.setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);

        const enableTextures = new UI.Checkbox('Enable Textures', !renderHacks.disableTextures);
        enableTextures.onchanged = () => {
            this.setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);

        const enableAmbientLighting = new UI.Checkbox('Enable Ambient Lighting', !renderHacks.disableAmbientLighting);
        enableAmbientLighting.onchanged = () => {
            this.setAmbientLightingEnabled(enableAmbientLighting.checked);
        };
        renderHacksPanel.contents.appendChild(enableAmbientLighting.elem);

        const enableTextureColor = new UI.Checkbox('Enable Texture Color', !renderHacks.disableTextureColor);
        enableTextureColor.onchanged = () => {
            this.setTextureColorEnabled(enableTextureColor.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextureColor.elem);

        const enableMeshInstances = new UI.Checkbox('Enable Mesh Instances', !renderHacks.disableMeshInstances);
        enableMeshInstances.onchanged = () => {
            this.setMeshInstancesEnabled(enableMeshInstances.checked);
        };
        renderHacksPanel.contents.appendChild(enableMeshInstances.elem);

        panels.push(renderHacksPanel);

        const debugPanel = new UI.Panel();
        debugPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        debugPanel.setTitle(UI.RENDER_HACKS_ICON, 'Debugging Hacks');
        const drawMeshOriginsCheckbox = new UI.Checkbox('Draw Mesh Origins', false);
        drawMeshOriginsCheckbox.onchanged = () => {
            debugHacks.drawMeshOrigins = drawMeshOriginsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawMeshOriginsCheckbox.elem);
        const drawSzmsPositionsCheckbox = new UI.Checkbox('Draw SZMS Positions', false);
        drawSzmsPositionsCheckbox.onchanged = () => {
            debugHacks.drawSzmsPositions = drawSzmsPositionsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawSzmsPositionsCheckbox.elem);
        const drawSzmePositionsCheckbox = new UI.Checkbox('Draw SZME Positions', false);
        drawSzmePositionsCheckbox.onchanged = () => {
            debugHacks.drawSzmePositions = drawSzmePositionsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawSzmePositionsCheckbox.elem);
        panels.push(debugPanel);

        // const layersPanel = new UI.LayerPanel();
        // layersPanel.setLayers(this.meshRenderers);
        // panels.push(layersPanel);

        this.flagLayers = createFlagLayers(this.meshRenderers)
        const layersPanel = new UI.LayerPanel(this.flagLayers, 'Flag Layers');
        panels.push(layersPanel);

        return panels;
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy(device);
        this.renderTarget.destroy(device);
    }
}

class FlagLayer {
    public name: string

    constructor(private flagValue: number, private meshRenderers: SlyMeshRenderer[], public visible: boolean = true) {
        this.name = `${binzero(flagValue, 9)} (${hexzero0x(flagValue, 3)})`;
    }
    public setVisible(v: boolean): void {
        this.visible = v;

        for (let meshRenderer of this.meshRenderers) {
            if (meshRenderer.meshChunk.flags == this.flagValue)
                meshRenderer.visible = v;
        }
    }
}

function checkFlag(value1: number, value2: number) {
    return (value1 & value2) != 0;
}

function getDefaultFlags() {
    return Data.MeshFlag.Static | Data.MeshFlag.Skybox;
}

function isDefaultFlag(flagValue: number) {
    if (Settings.SHOW_ALL_MESHES)
        return true;
    else
        return checkFlag(flagValue, getDefaultFlags());
}

function createFlagLayers(meshRenderers: SlyMeshRenderer[]): FlagLayer[] {
    const flagValues = [0x0, 0x2, 0x4, 0x6, 0xC, 0x10, 0x12, 0x14, 0x16, 0x20, 0x30, 0x40, 0x42, 0x44, 0x46, 0x56, 0x80, 0xB0, 0x102, 0x104, 0x110, 0x142, 0x156];

    // TODO: disable for release
    for (let meshRenderer of meshRenderers) {
        if (!flagValues.includes(meshRenderer.meshChunk.flags)) {
            console.warn(`no layer for flags ${hexzero(meshRenderer.meshChunk.flags)} in mesh of ${meshRenderer.meshChunk.flags}`);
        }
    }

    let flagLayers: FlagLayer[] = [];
    for (let flagValue of flagValues) {
        const isVisibleByDefault = isDefaultFlag(flagValue);
        flagLayers.push(new FlagLayer(flagValue, meshRenderers, isVisibleByDefault));
    }
    return flagLayers;
}

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
    private vertexColorBuffer: GfxBuffer;
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
        // let lighting: Float32Array;
        // if (meshChunk.szme)
        //     lighting = meshChunk.szme.lightingFloats;
        // else
        //     lighting = new Float32Array(meshChunk.positions.length * 4);
        // let lighting = new Float32Array(meshChunk.positions.length * 4);
        let vertexColor = meshChunk.vertexColorFloats;
        this.vertexColorBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, vertexColor.buffer);
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.INDEX, meshChunk.trianglesIndices.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Position
            { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Normal
            { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG, bufferByteOffset: 0, }, // TexCoord
            { location: 3, bufferIndex: 3, format: GfxFormat.F32_RGBA, bufferByteOffset: 0, }, // VertexColor
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 2 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 4 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
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
            { buffer: this.vertexColorBuffer, byteOffset: 0, },
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

class TextureData {
    public texture: GfxTexture;
    public sampler: GfxSampler;

    private makeGfxTexture(device: GfxDevice, texture: Data.Texture): GfxTexture {
        const hostAccessPass = device.createHostAccessPass();
        // console.log(`makeGfxTexture: size ${texture.width}x${texture.height}`);
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, texture.width, texture.height, 1));
        // console.log(gfxTexture);
        hostAccessPass.uploadTextureData(gfxTexture, 0, [texture.texels_rgba]);
        device.submitPass(hostAccessPass);
        return gfxTexture;
    }

    private makeGfxSampler(device: GfxDevice, gfxCache: GfxRenderCache): GfxSampler {
        return gfxCache.createSampler(device, {
            // wrapS: GfxWrapMode.CLAMP,
            // wrapT: GfxWrapMode.CLAMP,
            wrapS: GfxWrapMode.REPEAT,
            wrapT: GfxWrapMode.REPEAT,
            // minFilter: GfxTexFilterMode.POINT,
            // magFilter: GfxTexFilterMode.POINT,
            minFilter: GfxTexFilterMode.BILINEAR,
            magFilter: GfxTexFilterMode.BILINEAR,
            mipFilter: GfxMipFilterMode.NO_MIP,
            minLOD: 0, maxLOD: 0,
        });
    }

    constructor(device: GfxDevice, gfxCache: GfxRenderCache, texture: Data.Texture) {
        this.texture = this.makeGfxTexture(device, texture);
        this.sampler = this.makeGfxSampler(device, gfxCache);
    }
}

const textureMappingScratch = nArray(3, () => new TextureMapping());

function uintToGfxColor(col: number): GfxColor {
    const r = ((col >> 0) & 0xFF) / 255.0;
    const g = ((col >> 8) & 0xFF) / 255.0;
    const b = ((col >> 16) & 0xFF) / 255.0;
    const a = ((col >> 24) & 0xFF) / 255.0;
    return { r, g, b, a };
}

const viewMatScratch = mat4.create();
const modelViewMatScratch = mat4.create();

export class SlyMeshRenderer {
    public textureMatrix = mat4.create();

    private textureMappingDiffuse: (TextureMapping | null);
    private textureMappingAmbient: (TextureMapping | null);
    private textureMappingUnk: (TextureMapping | null);

    private megaStateFlags: Partial<GfxMegaStateDescriptor> = {};
    private isSkybox: boolean = false;

    private unkTexColors = new Array<GfxColor>(2);

    public name: string
    public visible: boolean = true;
    public setVisible(v: boolean): void {
        this.visible = v;
    }

    private rotX: mat4 = mat4.create();

    private instanceMatrices: mat4[] = [mat4.create()];

    constructor(
        textureData: (TextureData | null)[],
        public geometryData: GeometryData,
        public meshChunk: Data.MeshChunk,
        textureEntry: (Data.TextureEntry | null),
        private isFullyOpaque: boolean,
        meshInstances: Data.Mesh[] | undefined) {

        this.name = meshChunk.name;

        if (textureData[0]) {
            this.textureMappingDiffuse = new TextureMapping();
            this.textureMappingDiffuse.gfxTexture = textureData[0].texture;
            this.textureMappingDiffuse.gfxSampler = textureData[0].sampler;
        }
        if (textureData[1]) {
            this.textureMappingAmbient = new TextureMapping();
            this.textureMappingAmbient.gfxTexture = textureData[1].texture;
            this.textureMappingAmbient.gfxSampler = textureData[1].sampler;
        }
        if (textureData[2]) {
            this.textureMappingUnk = new TextureMapping();
            this.textureMappingUnk.gfxTexture = textureData[2].texture;
            this.textureMappingUnk.gfxSampler = textureData[2].sampler;
        }

        if (textureEntry) {
            this.unkTexColors[0] = uintToGfxColor(textureEntry?.unkCol1);
            this.unkTexColors[1] = uintToGfxColor(textureEntry?.unkCol2);
        } else {
            this.unkTexColors[0] = { r: 1, g: 1, b: 1, a: 1 };
            this.unkTexColors[1] = { r: 1, g: 1, b: 1, a: 1 };
        }

        this.megaStateFlags.frontFace = GfxFrontFaceMode.CW;
        // this.megaStateFlags.cullMode = GfxCullMode.BACK;
        this.megaStateFlags.cullMode = GfxCullMode.NONE;

        setAttachmentStateSimple(this.megaStateFlags, {
            blendMode: GfxBlendMode.ADD,
            blendSrcFactor: GfxBlendFactor.SRC_ALPHA,
            blendDstFactor: GfxBlendFactor.ONE_MINUS_SRC_ALPHA,
        });

        this.rotX = mat4.fromXRotation(this.rotX, 3 * 90 * MathConstants.DEG_TO_RAD);

        this.isSkybox = checkFlag(meshChunk.flags, Data.MeshFlag.Skybox);

        if (meshInstances)
            for (let meshInstance of meshInstances)
                this.instanceMatrices.push(meshInstance.instanceMatrix)
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplateRenderInst();

        template.setInputLayoutAndState(this.geometryData.inputLayout, this.geometryData.inputState);
        if (this.textureMappingDiffuse) {
            // todo: is scratch/copy necessary? ask jasper
            textureMappingScratch[0].copy(this.textureMappingDiffuse);
            if (this.textureMappingAmbient)
                textureMappingScratch[1].copy(this.textureMappingAmbient);
            if (this.textureMappingUnk)
                textureMappingScratch[2].copy(this.textureMappingUnk);
            template.setSamplerBindingsFromTextureMappings(textureMappingScratch);
        }
        template.setMegaStateFlags(this.megaStateFlags);

        let rendererLayer: GfxRendererLayer;
        if (this.isSkybox)
            rendererLayer = GfxRendererLayer.BACKGROUND;
        else if (this.isFullyOpaque)
            rendererLayer = GfxRendererLayer.OPAQUE;
        else
            rendererLayer = GfxRendererLayer.TRANSLUCENT;

        template.sortKey = makeSortKey(rendererLayer);

        if (this.isSkybox)
            computeViewMatrixSkybox(viewMatScratch, viewerInput.camera);
        else
            computeViewMatrix(viewMatScratch, viewerInput.camera);


        let texOffset = vec2.create();

        // if (!this.isSkybox)
        //     texOffset[1] = viewerInput.time / 10000.0;

        // TODO: instanced rendering

        for (let instanceMatrix of this.instanceMatrices) {
            const renderInstInstance = renderInstManager.newRenderInst();

            let offs = renderInstInstance.allocateUniformBuffer(SlyProgram.ub_ShapeParams, 4 * 4 + 4 + 4 + 2);
            const d = renderInstInstance.mapUniformBufferF32(SlyProgram.ub_ShapeParams);

            mat4.copy(modelViewMatScratch, viewMatScratch);

            mat4.mul(modelViewMatScratch, modelViewMatScratch, this.rotX);
            mat4.mul(modelViewMatScratch, modelViewMatScratch, instanceMatrix);

            if (this.isSkybox)
                mat4.scale(modelViewMatScratch, modelViewMatScratch, [10, 10, 10]);

            offs += fillMatrix4x4(d, offs, modelViewMatScratch);
            offs += fillColor(d, offs, this.unkTexColors[0]);
            offs += fillColor(d, offs, this.unkTexColors[1]);
            offs += fillVec2v(d, offs, texOffset);

            renderInstInstance.drawIndexes(this.geometryData.indexCount);
            renderInstManager.submitRenderInst(renderInstInstance);

            if (renderHacks.disableMeshInstances)
                break;
        }

        renderInstManager.popTemplateRenderInst();
    }
}
