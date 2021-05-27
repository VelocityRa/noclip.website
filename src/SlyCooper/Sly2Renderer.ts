import * as Viewer from '../viewer';
import * as UI from '../ui';
import { FakeTextureHolder } from '../TextureHolder';
import { GfxDevice, GfxRenderPass, GfxBindingLayoutDescriptor, GfxMegaStateDescriptor, GfxCullMode, GfxFrontFaceMode, GfxBlendMode, GfxBlendFactor, GfxSampler, GfxTexture, GfxWrapMode, GfxTexFilterMode, GfxMipFilterMode, GfxProgramDescriptorSimple, makeTextureDescriptor2D, GfxColor } from "../gfx/platform/GfxPlatform";
import { preprocessProgramObj_GLSL, DefineMap } from "../gfx/shaderc/GfxShaderCompiler";
import { pushAntialiasingPostProcessPass, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRenderInstManager, GfxRendererLayer, makeSortKey, makeSortKeyOpaque } from "../gfx/render/GfxRenderInstManager";
import { fillVec2v, fillMatrix4x4, fillMatrix4x3, fillVec4, fillVec4v, fillColor } from "../gfx/helpers/UniformBufferHelpers";
import { mat4, vec3, vec2, vec4, quat } from "gl-matrix";
import { computeViewMatrix, CameraController, computeViewMatrixSkybox } from "../Camera";
import { nArray, assertExists, hexzero0x, hexzero, binzero, binzero0b, assert } from "../util";
import { TextureMapping } from "../TextureHolder";
import { MathConstants, scaleMatrix, transformVec3Mat4w0 } from "../MathHelpers";
import { AABB } from "../Geometry";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { Texture } from "./SlyData";
import { DynamicObjectInstance, LevelObject, parseObjectEntries, TextureContainer, MeshContainer, MeshChunk, Mesh } from './Sly2Data';
import * as Settings from './SlyConstants';
import { drawWorldSpaceAABB, getDebugOverlayCanvas2D, drawWorldSpacePoint, drawWorldSpaceVector, drawWorldSpaceLine, drawWorldSpaceBasis } from "../DebugJunk";
import { colorNewFromRGBA, Color, Magenta, colorToCSS, Red, Green, Blue, Cyan, colorFromHSL, OpaqueBlack, White } from "../Color";
import { GfxBuffer, GfxInputLayout, GfxInputState, GfxBufferUsage, GfxVertexAttributeDescriptor, GfxFormat, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency } from "../gfx/platform/GfxPlatform";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxrAttachmentSlot, makeBackbufferDescSimple } from '../gfx/render/GfxRenderGraph';
import { GrabListener } from '../GrabManager';
import { connectToSceneCollisionEnemyStrongLight } from '../SuperMarioGalaxy/ActorUtil';
import { FloatingPanel } from '../DebugFloaters';
import { NamedArrayBufferSlice } from '../DataFetcher';
import { DataStream } from './DataStream';
import ArrayBufferSlice from '../ArrayBufferSlice';
import { downloadBuffer } from '../DownloadUtils';

class SlyRenderHacks {
    disableTextures = false;
    disableVertexColors = false;
    disableAmbientLighting = true;
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
    // vec2 u_TexOffset;
};

// #define u_BaseDiffuse (u_Misc[0].x)
// #define u_BaseAmbient (u_Misc[0].y)

#define u_BaseDiffuse 1.0
#define u_BaseAmbient 0.2

uniform sampler2D u_Texture[1];

#define u_DiffuseTexture SAMPLER_2D(u_Texture[0])
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

vec3 AdjustContrastCurve(vec3 color, float contrast) {
    return clamp(mix(vec3(0.5, 0.5, 0.5), color, contrast), 0.0, 1.0);
}

void main() {
    // gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    // return;

#if 1
    vec2 t_TexCoord = mod(v_TexCoord /* + u_TexOffset */, vec2(1.0));

#if ENABLE_TEXTURES
    vec4 t_DiffuseMapColor = texture(u_DiffuseTexture, t_TexCoord.xy);
    gl_FragColor.a = clamp(t_DiffuseMapColor.a * 2.0, 0.0, 1.0);
    // gl_FragColor.rgb = t_DiffuseMapColor.rgb;
    // return;
#else
    vec4 t_DiffuseMapColor = vec4(1.0);
    gl_FragColor.a = 1.0;
#endif

#if ENABLE_VERTEX_COLORS
    vec3 vertexColor = v_VertexColor;
#else
    vec3 vertexColor = vec3(1.0);
#endif

    float vertexLighting = 0.22;
    float tc1_w = 0.5;

    vec3 diffuseFinal = t_DiffuseMapColor.rgb * vertexColor * vertexLighting;

#if ENABLE_AMBIENT_LIGHTING
    vec3 lightDirection = normalize(vec3(0.1027, 0.02917, 0.267));
    vec3 lightColor = vec3(10./255., 23./255., 26./255.) * 0.5;
    float ambientLambert = clamp(max(dot(v_Normal.xyz, lightDirection), 0.0), 0.0, 1.0);
    vec3 ambientColor = lightColor * ambientLambert;

    vec3 ambientFinal = ambientColor;
    vec3 unkFinal = diffuseFinal / 2.0;
#else
    vec3 ambientFinal = vec3(0.0);
    vec3 unkFinal = diffuseFinal;
#endif

    // TODO: implement more properly
    // if (gl_FragColor.a == 0.0)
        // discard;

    gl_FragColor.rgb = (ambientFinal * tc1_w + unkFinal) * 4.0;

    gl_FragColor.rgb *= 1.2;

    // gl_FragColor.rgb = AdjustContrastCurve(gl_FragColor.rgb, 1.1);
#endif
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
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 1, },
];

class Ray {
    private sign = new Uint8Array(3);
    private invDir: vec3;

    constructor(public pos: vec3, public dir: vec3) {
        this.invDir = vec3.inverse(vec3.create(), dir);

        this.sign[0] = (this.invDir[0] < 0) ? 1 : 0;
        this.sign[1] = (this.invDir[1] < 0) ? 1 : 0;
        this.sign[2] = (this.invDir[2] < 0) ? 1 : 0;
    }

    public intersectAABB(aabb: EditorAABB): boolean {
        // Reference: https://gamedev.stackexchange.com/a/18459

        const t1 = (aabb.minX - this.pos[0]) * this.invDir[0];
        const t2 = (aabb.maxX - this.pos[0]) * this.invDir[0];
        const t3 = (aabb.minY - this.pos[1]) * this.invDir[1];
        const t4 = (aabb.maxY - this.pos[1]) * this.invDir[1];
        const t5 = (aabb.minZ - this.pos[2]) * this.invDir[2];
        const t6 = (aabb.maxZ - this.pos[2]) * this.invDir[2];

        const tMin = Math.max(Math.max(Math.min(t1, t2), Math.min(t3, t4)), Math.min(t5, t6));
        const tMax = Math.min(Math.min(Math.max(t1, t2), Math.max(t3, t4)), Math.max(t5, t6));

        let t: number;

        // if tMax < 0, ray (line) is intersecting AABB, but the whole AABB is behind us
        if (tMax < 0) {
            t = tMax;
            return false;
        }

        // if tMin > tMax, ray doesn't intersect AABB
        if (tMin > tMax) {
            t = tMax;
            return false;
        }

        t = tMin;

        const hitFront = t > 0;
        return hitFront;
    }
}

interface Line {
    posStart: vec3;
    posEnd: vec3;
}

interface Sphere {
    center: vec3;
    radius: number;
}

function vec3Str(v: vec3) {
    return `\t${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}`;
}

function vec4Str(v: vec4) {
    return `\t${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}, ${v[3].toFixed(3)}`;
}

function mat4Str(m: mat4) {
    let str = "\t";
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            str += `${m[x + y * 4].toFixed(3)} `;
        }
        str += '\n';
        if (y != 3)
            str += '\t'
    }
    return str;
}

let gSly2Renderer: Sly2Renderer;

class EditorPanel extends FloatingPanel {
    private transformToolRadioButtons: UI.RadioButtons;
    private translateAxisRadioButtons: UI.RadioButtons;
    private gizmoSensitivitySlider: UI.Slider;
    private duplicateBtn: HTMLElement;
    private bakeBtn: HTMLElement;
    private selectedObjectDiv: HTMLInputElement;

    // TODO: no ondrag... just radiobuttons for Plane select
    // after selection, to prevent drag
    // get started on emitting
    // orientate more correctly based on view
    // todo plane translate btns, reset btn, rotate, scale

    constructor(private ui: UI.UI, private viewer: Viewer.Viewer) {
        super();
        this.setWidth(500);
        this.contents.style.maxHeight = '';
        this.contents.style.overflow = '';
        this.elem.onmouseout = () => {
            this.elem.style.opacity = '0.8';
        };
        this.elem.style.opacity = '0.8';
        this.setTitle(UI.SAND_CLOCK_ICON, 'Editor');
        document.head.insertAdjacentHTML('beforeend', `
        <style>
            button.EditorButton {
                font: 16px monospace;
                font-weight: bold;
                border: none;
                width: 100%;
                color: inherit;
                padding: 0.15rem;
                text-align: center;
                background-color: rgb(64, 64, 64);
                cursor: pointer;
                draggable: true;
            }
            hr {
                border-color: #BBBBBB;
                margin: 10px 10px;
            }
        </style>
        `);

        this.transformToolRadioButtons = new UI.RadioButtons('Transform Tool', ['Translate', 'Rotate', 'Scale']);
        this.transformToolRadioButtons.onselectedchange = () => {
            gSly2Renderer.transformToolMode = this.transformToolRadioButtons.selectedIndex;
        };
        this.transformToolRadioButtons.setSelectedIndex(0);
        this.contents.appendChild(this.transformToolRadioButtons.elem);

        this.contents.insertAdjacentHTML('beforeend', `<hr>`);

        this.translateAxisRadioButtons = new UI.RadioButtons('Translate Axis', ['X/Z', 'X/Y', 'Y/Z']);
        this.translateAxisRadioButtons.onselectedchange = () => {
            gSly2Renderer.translateAxisMode = this.translateAxisRadioButtons.selectedIndex;
        };
        this.translateAxisRadioButtons.setSelectedIndex(0);
        this.contents.appendChild(this.translateAxisRadioButtons.elem);

        this.gizmoSensitivitySlider = new UI.Slider();
        this.gizmoSensitivitySlider.setLabel('Translate Sensitivity');
        this.gizmoSensitivitySlider.setRange(0.5, 10);
        this.gizmoSensitivitySlider.onvalue = (v: number) => {
            gSly2Renderer.gizmoSensitivity = v;
        };
        this.gizmoSensitivitySlider.setValue(gSly2Renderer.gizmoSensitivity);
        this.contents.appendChild(this.gizmoSensitivitySlider.elem);

        this.contents.insertAdjacentHTML('beforeend', `
        <hr>
        <b>Selected Object:</b> <div id="selectedObjectDiv"></div>
        <button id="duplicateBtn" class="EditorButton">Duplicate</button>
        <hr>
        <button id="bakeBtn" class="EditorButton">Bake Level</button>
        `);

        /*
        this.contents.insertAdjacentHTML('beforeend', `
        <div style="display: grid; grid-template-columns: 3fr 1fr 1fr; align-items: center;">
            <div class="SettingsHeader">Editor Mode</div>
            <button id="enableBtn" class="EditorButton EnableEditorMode">Enable</button>
            <button id="disableBtn" class="EditorButton DisableEditorMode">Disable</button>
        </div>
        <button id="bakeBtn" class="EditorButton">Bake</button>
        <div id="editorPanelContents" hidden></div>
        `);
        */
        this.contents.style.lineHeight = '36px';
        this.duplicateBtn = this.contents.querySelector('#duplicateBtn') as HTMLInputElement;
        this.bakeBtn = this.contents.querySelector('#bakeBtn') as HTMLInputElement;
        this.selectedObjectDiv = this.contents.querySelector('#selectedObjectDiv') as HTMLInputElement;

        // A listener to give focus to the canvas whenever it's clicked, even if the panel is still up.
        const keepFocus = function (e: MouseEvent) {
            if (e.target === viewer.canvas)
                document.body.focus();
        }
        document.addEventListener('mousedown', keepFocus);

        this.duplicateBtn.onclick = () => {
            gSly2Renderer.duplicateSelectedObject();
        }

        this.bakeBtn.onclick = () => {
            gSly2Renderer.bake();
        }

        // this.elem.style.display = 'none';
    }

    public setSelectedObject(selectedObject: LevelObject, dynIdx: number) {
        if (selectedObject)
            this.selectedObjectDiv.innerHTML = `[${selectedObject.header.index}] [${dynIdx}] ${selectedObject.header.name}`;
        else
            this.selectedObjectDiv.innerHTML = 'None';
    }
}

enum MeshInstanceType {
    Identity,
    MeshInstance,
    DynObj,
}

export class Sly2Renderer implements Viewer.SceneGfx {
    public textureHolder = new FakeTextureHolder([]);

    private program: (GfxProgramDescriptorSimple | null) = null;
    private renderHelper: GfxRenderHelper;
    private modelMatrix: mat4 = mat4.create();
    private meshRenderers: Sly2MeshRenderer[] = [];
    // private meshRenderersReverse: Sly2MeshRenderer[] = [];

    // Editor stuff

    private editorPanel: EditorPanel;

    public nonInteractiveListener: GrabListener = this;

    private viewerInput: Viewer.ViewerRenderInput;

    private debugRays: Ray[] = [];
    private debugLines: Line[] = [];

    private selectSeparateMeshes = false;

    private selectedObject: (LevelObject | null) = null;
    public selectedObjectDynObjIndex = -1;
    private selectedObjectRenderers: Sly2MeshRenderer[] = [];
    private selectedObjectRendererMeshInstIndices: number[] = [];
    private selectedObjectAABB: AABB;

    private selectedMesh: (Mesh | null) = null;
    private selectedMeshInstanceIndex: number;

    public transformToolMode = 0;
    public translateAxisMode = 0;

    private meshRenderersDuplicated: Sly2MeshRenderer[] = [];

    private editorDynObjAddrTransforms: Map<number, mat4> = new Map();

    public gizmoSensitivity = 5.0;

    //

    private createShader(device: GfxDevice) {
        this.program = preprocessProgramObj_GLSL(device, new SlyProgram(renderHacks));
    }

    constructor(
        device: GfxDevice,
        private objects: LevelObject[],
        private dynObjInsts: DynamicObjectInstance[],
        texIdToTex: Map<string, Texture>,
        private levelFileName: string,
        private levelData: NamedArrayBufferSlice
    ) {

        gSly2Renderer = this;
        this.renderHelper = new GfxRenderHelper(device);

        const gfxCache = this.renderHelper.getCache();

        for (let object of objects) {
            // if (object.header.index != 286)
            // if (object.header.index != 269)
            // if (object.header.index < 50 || object.header.index > 100)
            // continue;

            for (let meshContainer of object.meshContainers) {
                for (let mesh of meshContainer.meshes) {
                    let currentMeshRenderers: Sly2MeshRenderer[] = [];

                    let meshInstanceMatrices = [mat4.create()];
                    mesh.instancesAll = [mat4.create()];
                    mesh.instanceAddressesAll.push(0);
                    let meshInstanceTypes: MeshInstanceType[] = [MeshInstanceType.Identity];

                    for (let meshInstance of mesh.instances) {
                        meshInstanceMatrices.push(mat4.clone(meshInstance));
                        mesh.instancesAll.push(mat4.clone(meshInstance));
                        meshInstanceTypes.push(MeshInstanceType.MeshInstance);
                    }
                    for (let meshInstanceAddress of mesh.instanceAddresses) {
                        mesh.instanceAddressesAll.push(meshInstanceAddress);
                    }

                    // TODO: This is slow!
                    let dynObjMats: mat4[] = [];
                    for (let dynObjInst of dynObjInsts) {
                        if (object.header.id0 == dynObjInst.objId0) {
                            dynObjMats.push(dynObjInst.matrix);
                            if (this.selectSeparateMeshes)
                                mesh.instanceAddressesAll.push(1);
                            else
                                mesh.instanceAddressesAll.push(dynObjInst.matrixAddress);
                        }
                    }
                    for (let dynObjMat of dynObjMats) {
                        meshInstanceMatrices.push(mat4.clone(dynObjMat));
                        mesh.instancesAll.push(mat4.create()); // TODO?: this doesn't go through C2 xform
                        meshInstanceTypes.push(MeshInstanceType.DynObj);
                    }

                    let meshInstanceMatrices1: mat4[] = [];
                    if (mesh.u0 == 0) {
                        let transformC2 = meshContainer.meshC2Entries[mesh.containerInstanceMatrixIndex].transformMatrix;
                        if (transformC2) {
                            for (let i = 0; i < meshInstanceMatrices.length; ++i) {
                                // mat4.multiply(meshInstanceMatrices[i], meshInstanceMatrices[i], transformC2!);
                                meshInstanceMatrices1.push(transformC2!);
                            }
                        }
                    }
                    if (meshInstanceMatrices1.length == 0)
                        for (let i = 0; i < meshInstanceMatrices1.length; ++i)
                            meshInstanceMatrices1.push(mat4.create());

                    // mesh.instancesAll = meshInstanceMatrices;

                    let chunkIdx = 0;
                    for (let meshChunk of mesh.chunks) {
                        // TODO(opt): don't make 2 separate Sly2MeshRenderers for this

                        for (let triIdx = 0; triIdx < 2; triIdx++) {
                            let triangleIndices = (triIdx == 0) ? meshChunk.trianglesIndices1 : meshChunk.trianglesIndices2;

                            const geometryData = new GeometryData(device, gfxCache, meshChunk, triangleIndices);

                            let isFullyOpaque = true;

                            let textureData: (TextureData | null)[] = nArray(2, () => null);
                            if (mesh.szme) {
                                let texId = (triIdx == 0) ? mesh.szme!.chunks[chunkIdx].textureId0 : mesh.szme!.chunks[chunkIdx].textureId1;
                                if (texId) {
                                    const textureDiffuse = texIdToTex.get(`${object.header.index}_${texId!}`);
                                    if (textureDiffuse) {
                                        textureData[0] = new TextureData(device, gfxCache, textureDiffuse)
                                        isFullyOpaque = textureDiffuse.isFullyOpaque;
                                    }
                                }
                            }

                            currentMeshRenderers.push(new Sly2MeshRenderer(textureData, geometryData, meshChunk, isFullyOpaque, [...meshInstanceMatrices], [...meshInstanceMatrices1], [...meshInstanceTypes], mesh, meshContainer, object));

                        }
                        chunkIdx++;
                    }

                    mesh.renderers = currentMeshRenderers;
                    this.meshRenderers.push(...currentMeshRenderers);
                }
            }
            // this.meshRenderersReverse = this.meshRenderers.slice().reverse();
        }
    }

    public prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput, renderInstManager: GfxRenderInstManager) {
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
        // for (let meshRenderer of this.meshRenderersDuplicated) {
        //     meshRenderer.prepareToRender(renderInstManager, viewerInput);
        // }
        // for (let meshRenderer of this.meshRenderersReverse) {
        //     meshRenderer.prepareToRender(renderInstManager, viewerInput);
        // }

        renderInstManager.popTemplateRenderInst();

        this.renderHelper.prepareToRender(device);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        this.viewerInput = viewerInput;
        const renderInstManager = this.renderHelper.renderInstManager;
        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, opaqueBlackFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(device, passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput, renderInstManager);
        this.renderHelper.renderGraph.execute(device, builder);
        renderInstManager.resetRenderInsts();

        // const ctx = getDebugOverlayCanvas2D();
        // drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, [0,0,0], Magenta, 5);

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

                // if (meshRenderer.meshChunk.szme) {
                //     if (debugHacks.drawMeshOrigins) {
                //         let origin = meshRenderer.meshChunk.szme?.origin;
                //         let originVec = vec3.fromValues(origin[0], origin[2], -origin[1]);
                //         drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, originVec, Green, 9);
                //     }

                //     if (debugHacks.drawSzmePositions) {
                //         let posVec = meshRenderer.meshChunk.szme.positions;
                //         for (let i = 0; i < posVec.length; i += 3) {
                //             const p = vec3.fromValues(posVec[i + 0], posVec[i + 2], -posVec[i + 1]);
                //             drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 7);

                //         }
                //     }
                // }
            }
        }

        /*
        let aabb = new AABB(-1000, -5000, -1000, 100, 5000, 100);
        const ctx = getDebugOverlayCanvas2D();
        drawWorldSpaceAABB(ctx, viewerInput.camera.clipFromWorldMatrix, aabb);

        const dbgPos = this.meshRenderers[148].meshChunk.szme?.positions!;
        for (let i = 0; i < dbgPos.length; i += 3) {
            const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
            drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 50);
            // console.log(`${p}`);
        }
        dbgPos = this.meshRenderers[148].meshChunk.positions!;
        for (let i = 0; i < dbgPos.length; i += 3) {
            const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
            drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 20);
            // console.log(`${p}`);
        }

        for (let meshRenderer of this.meshRenderers) {
        let dbgPos = meshRenderer.meshChunk.positions;
        for (let i = 0; i < dbgPos.length; i += 3) {
            const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
            drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 13);
        }

        if (meshRenderer.meshChunk.szme) {
        let orig = meshRenderer.meshChunk.szme?.origin;
        let dbgPos = vec3.fromValues(orig[0], orig[2], -orig[1]);
        drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, dbgPos, Green, 7);

        dbgPos = meshRenderer.meshChunk.szme.positions;
        for (let i = 0; i < dbgPos.length; i += 3) {
            const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
            drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 4);
        }}}
        */

        if (false)
            for (let debugRay of this.debugRays) {
                let randomColor = colorNewFromRGBA(0, 0, 0);
                const pseudoRandomFloat = (debugRay.pos[0] + debugRay.pos[1] + debugRay.pos[2] + debugRay.dir[0] + debugRay.dir[1] + debugRay.dir[2]) % 1;
                colorFromHSL(randomColor, pseudoRandomFloat, 0.5, 0.5, 1.0);
                drawWorldSpaceVector(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, debugRay.pos, debugRay.dir, 2000, randomColor, 3);
            }

        if (false)
            for (let debugLine of this.debugLines) {
                drawWorldSpaceLine(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, debugLine.posStart, debugLine.posEnd, Cyan);
            }

        // drawWorldSpaceBasis(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, mat4.create(), 10000, 1);

        if (this.selectSeparateMeshes) {
            if (this.selectedMesh) {
                const aabb = this.selectedMesh.aabb!;
                drawWorldSpaceAABB(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, aabb, mat4.create(), White, 3);

                const aabbCenter = aabb.centerPoint(vec3.create());
                const aabbExtents = aabb.extents(vec3.create());
                // const basisScale = Math.min(Math.min(aabbExtents[0], aabbExtents[1], aabbExtents[2]));
                const basisMat = mat4.fromRotationTranslationScale(mat4.create(), quat.create(), aabbCenter, aabbExtents);

                drawWorldSpaceBasis(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, basisMat, 1, 4);

                for (let renderer of this.selectedMesh.renderers) {
                    // for (let aabb of renderer.aabbs)
                    const aabb = renderer.aabbs[this.selectedMeshInstanceIndex];
                    drawWorldSpaceAABB(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, aabb, mat4.create(), renderer.aabbColor, 1);
                }
            }
        } else {
            if (this.selectedObject) {
                drawWorldSpaceAABB(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, this.selectedObjectAABB, mat4.create(), White, 3);

                const aabbCenter = this.selectedObjectAABB.centerPoint(vec3.create());
                const aabbExtents = this.selectedObjectAABB.extents(vec3.create());
                // const basisScale = Math.min(Math.min(aabbExtents[0], aabbExtents[1], aabbExtents[2]));
                const basisMat = mat4.fromRotationTranslationScale(mat4.create(), quat.create(), aabbCenter, aabbExtents);

                drawWorldSpaceBasis(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, basisMat, 1, 4);
            }
        }
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

        // const editorPanel = new UI.Panel();
        // editorPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        // editorPanel.setTitle(UI.SAND_CLOCK_ICON, 'Editor');
        // const clearSelectionButton = new UI.Button('Clear Selection');
        // clearSelectionButton.onmousedown = () => {
        //     this.selectedMesh = null;
        // };
        // editorPanel.contents.appendChild(clearSelectionButton.elem);
        // const clearDebugRaysButton = new UI.Button('Clear Debug Rays');
        // clearDebugRaysButton.onmousedown = () => {
        //     this.debugRays = [];
        // };
        // editorPanel.contents.appendChild(clearDebugRaysButton.elem);
        // panels.push(editorPanel);

        const ui = ((window.main.ui) as UI.UI);
        this.editorPanel = new EditorPanel(ui, ((window.main.viewer) as Viewer.Viewer));
        ui.toplevel.appendChild(this.editorPanel.elem); // todo need to check it's added just once
        // panels.push(editorPanel);

        // const layersPanel = new UI.LayerPanel();
        // layersPanel.setLayers(this.meshRenderers);
        // panels.push(layersPanel);

        return panels;
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy(device);
    }

    private calculateRay(e: MouseEvent) {
        // Reference: https://antongerdelan.net/opengl/raycasting.html

        // Viewport (2D) -> NDC (3D)
        const mouseClipX = 2 * e.clientX * window.devicePixelRatio / this.viewerInput.backbufferWidth - 1;
        const mouseClipY = (2 * e.clientY * window.devicePixelRatio / this.viewerInput.backbufferHeight - 1) * -1;
        const rayNdc = vec3.fromValues(mouseClipX, mouseClipY, 1.0);

        // NDC (3D) -> Homogeneous clip (4D)
        // Negative Z to point forwards. W 1 for identity.
        const rayClip = vec4.fromValues(rayNdc[0], rayNdc[1], -1, 1);

        // Homogeneous clip (4D) -> Eye (4D)
        const projMatrix = this.viewerInput.camera.projectionMatrix;
        const invProjMatrix = mat4.invert(mat4.create(), projMatrix);
        let rayEye = vec4.transformMat4(vec4.create(), rayClip, invProjMatrix);
        // We only needed to un-project X and Y so let's set Z and W to mean "forwards, and not a point"
        rayEye = vec4.fromValues(rayEye[0], rayEye[1], -1, 0);

        // Eye (4D) -> World (4D)
        const viewMatrix = this.viewerInput.camera.viewMatrix;
        const invViewMatrix = mat4.invert(mat4.create(), viewMatrix);
        let rayWorldVec4 = vec4.transformMat4(vec4.create(), rayEye, invViewMatrix);
        let rayWorld = vec3.fromValues(rayWorldVec4[0], rayWorldVec4[1], rayWorldVec4[2]);
        vec3.normalize(rayWorld, rayWorld);

        const rayPos = mat4.getTranslation(vec3.create(), this.viewerInput.camera.worldMatrix);

        const ray = new Ray(rayPos, rayWorld);
        this.debugRays.push(ray);
        return ray;
    }

    private static hitSphere(sphere: Sphere, ray: Ray): boolean {
        // Reference: https://www.scratchapixel.com/lessons/3d-basic-rendering/minimal-ray-tracer-rendering-simple-shapes/ray-sphere-intersection
        const l = vec3.subtract(vec3.create(), sphere.center, ray.pos);
        const tca = vec3.dot(l, ray.dir);

        const d2 = vec3.dot(l, l) - tca * tca;
        const radius2 = sphere.radius * sphere.radius;
        if (d2 > radius2)
            return false;

        const thc = Math.sqrt(radius2 - d2);
        let t0 = tca - thc;
        let t1 = tca + thc;

        if (t0 > t1)
            [t0, t1] = [t1, t0];

        if (t0 < 0) {
            t0 = t1; // if t0 is negative, let's use t1 instead
            if (t0 < 0)
                return false; // both t0 and t1 are negative
        }

        return true;
    }

    private calculateMeshAABB(mesh: Mesh, meshIndex: number): void {
        let meshAABB = new AABB();

        for (let renderer of mesh.renderers) {
            const aabb = renderer.aabbs[meshIndex];
            meshAABB.union(meshAABB, aabb);
        }

        mesh.aabb = meshAABB;
    }

    // private calculateObjectAABB(object: LevelObject,) {
    // }

    public transformSelectedMesh(m: mat4): void {
        // TODO: Fix

        if (this.selectedMesh) {
            // for (let renderer of this.selectedMesh.renderers) {
            //     const instanceMatrix = renderer.meshInstanceMatrices[this.selectedMeshInstanceIndex]
            //     mat4.multiply(instanceMatrix, instanceMatrix, m);

            //     renderer.calculateAABBs();
            // }

            // this.calculateMeshAABB(this.selectedMesh, this.selectedMeshInstanceIndex);
        }
    }

    public translateSelectedMesh(v: vec3): void {
        // this.transformSelectedMesh(mat4.fromTranslation(mat4.create(), v));

        // TODO: Fix

        if (this.selectedMesh) {
            // for (let renderer of this.selectedMesh.renderers) {
            //     const instanceMatrix = renderer.meshInstanceMatrices[this.selectedMeshInstanceIndex]
            //     const origScale = mat4.getScaling(vec3.create(), instanceMatrix);

            //     vec3.div(v, v, origScale);
            //     mat4.translate(instanceMatrix, instanceMatrix, v);

            //     renderer.calculateAABBs();
            // }

            // this.calculateMeshAABB(this.selectedMesh, this.selectedMeshInstanceIndex);
        }
    }

    public duplicateSelectedObject() {
        if (this.selectedObject) {
            for (let i = 0; i < this.selectedObjectRenderers.length; ++i) {
                const renderer = this.selectedObjectRenderers[i];
                const meshInstIdx = this.selectedObjectRendererMeshInstIndices[i];

                renderer.addDuplicatedMatrix(meshInstIdx);
                renderer.calculateAABBs();
            }
        }
    }

    //
    // GrabListener
    //
    public onGrab(e: MouseEvent): void {
        const ray = this.calculateRay(e);
        // console.log(`ray: ${vec3Str(ray.pos)}  ${vec3Str(ray.dir)}`);
        let minDist = Infinity;
        let hasAHit = false;
        let hitAABB: EditorAABB;
        let hitMeshRenderer: Sly2MeshRenderer;
        let hitMeshRendererIndex: number;

        // Following code assumes meshRenderer.aabbs.length == meshRenderer.meshInstances.length

        for (let meshRenderer of this.meshRenderers) {
            if (meshRenderer.object.header.name == 'f_nightclub_exterior' ||
                meshRenderer.object.header.name == 'f_nightclub_exterior_rig')
                continue;

            assert(meshRenderer.aabbs.length == meshRenderer.meshInstanceMatrices0.length);

            for (let i = 0; i < meshRenderer.aabbs.length; ++i) {
                const aabb = meshRenderer.aabbs[i];
                if (aabb.isHuge)
                    continue;
                /*
                const aabbSphere = aabb.sphere;
                // console.log(` sphere r ${aabbSphere.radius}  ${vec3Str(aabbSphere.center)}`);
                if (Sly2Renderer.hitSphere(aabbSphere, ray)) {
                    const dist = vec3.distance(ray.pos, aabbSphere.center);
                */
                if (ray.intersectAABB(aabb)) {
                    const dist = vec3.distance(ray.pos, aabb.centerPoint(vec3.create()));

                    if (dist < minDist) {
                        hitAABB = aabb;
                        hitMeshRenderer = meshRenderer;
                        hitMeshRendererIndex = i;
                        minDist = dist;
                        hasAHit = true;
                    }
                }

            }
        }

        if (hasAHit) {
            // hitAABB!.isDrawn = true;

            const mesh = hitMeshRenderer!.mesh;

            if (this.selectSeparateMeshes) {
                this.selectedMesh = mesh;
                this.selectedMeshInstanceIndex = hitMeshRendererIndex!;
                this.calculateMeshAABB(mesh, this.selectedMeshInstanceIndex);
                this.selectedMesh.dirtyInstIndices.add(hitMeshRendererIndex!);
            } else {
                this.selectedObject = hitMeshRenderer!.object;

                const meshInstanceTypes = hitMeshRenderer!.meshInstanceTypes;
                let hitInstType = meshInstanceTypes[hitMeshRendererIndex!];

                if (hitInstType == MeshInstanceType.DynObj) {
                    let dynObjCount = 0;
                    for (let i = 0; i < hitMeshRendererIndex!; ++i) {
                        if (meshInstanceTypes[i] == MeshInstanceType.DynObj) {
                            dynObjCount++;
                        }
                    }
                    this.selectedObjectDynObjIndex = dynObjCount;


                    this.editorPanel.setSelectedObject(this.selectedObject, this.selectedObjectDynObjIndex);

                    // TODO? index is not always right ?

                    this.selectedObjectAABB = new AABB();

                    this.selectedObjectRenderers = [];
                    this.selectedObjectRendererMeshInstIndices = [];
                    for (let meshCont of this.selectedObject.meshContainers) {
                        for (let mesh of meshCont.meshes) {
                            for (let renderer of mesh.renderers) {
                                // for (let aabb of renderer.aabbs)
                                if (this.selectedObjectDynObjIndex == -1) {
                                    // const aabb = renderer.aabbs[this.selectedMeshInstanceIndex];
                                    // objectAABB.union(objectAABB, aabb);
                                    // return;
                                } else {
                                    let dynInstCount = 0;
                                    for (let instTypeIndex = 0; renderer.meshInstanceTypes.length; instTypeIndex++) {
                                        const type = renderer.meshInstanceTypes[instTypeIndex];

                                        if (type == MeshInstanceType.DynObj) {
                                            if (dynInstCount == this.selectedObjectDynObjIndex) {
                                                this.selectedObjectRenderers.push(renderer);
                                                this.selectedObjectRendererMeshInstIndices.push(instTypeIndex);
                                                const aabb = renderer.aabbs[instTypeIndex];
                                                this.selectedObjectAABB.union(this.selectedObjectAABB, aabb);
                                                // debugger;
                                                break;
                                            }
                                            dynInstCount++;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    this.selectedObjectDynObjIndex = -1;
                    console.log(`non dynobj instance selected: ${this.selectedObject.header.name}`);
                    // TODO
                    this.selectedObject = null;
                }
            }
        }
        // todo mark & draw upper obj inst
    }
    public onMotion(dx: number, dy: number): void {
        if (this.selectedMesh) {
            // vec3.add(this.selectedMesh.accumulatedTranslation, this.selectedMesh.accumulatedTranslation, translateVec);
            // this.translateSelectedMesh(translateVec);
        } else {
            this.selectedObjectAABB.reset();

            if (this.transformToolMode == 0) {
                dx *= this.gizmoSensitivity;
                dy *= this.gizmoSensitivity;
            }

            let translateVec: vec3;
            if (this.translateAxisMode == 0)
                translateVec = vec3.fromValues(dx, -dy, 0);
            else if (this.translateAxisMode == 1)
                translateVec = vec3.fromValues(dx, 0, -dy);
            else
                translateVec = vec3.fromValues(0, dx, -dy);

            for (let i = 0; i < this.selectedObjectRenderers.length; ++i) {
                const renderer = this.selectedObjectRenderers[i];

                const meshInstIdx = this.selectedObjectRendererMeshInstIndices[i];

                let editorMat = renderer.levelEditorMatrices[meshInstIdx];

                if (this.transformToolMode == 0) {
                    mat4.translate(editorMat, editorMat, translateVec);
                } else if (this.transformToolMode == 1) {
                    // TODO
                    mat4.rotateX(editorMat, editorMat, dx / 100);
                } else {
                    // TODO
                    mat4.scale(editorMat, editorMat, vec3.fromValues(1 + dx / 100, 1 + dx / 100, 1 + dx / 100));
                }

                renderer.calculateAABBs();

                const aabb = renderer.aabbs[meshInstIdx];
                this.selectedObjectAABB.union(this.selectedObjectAABB, aabb);
            }

            // TODO: This is slow!
            let dynObjs: DynamicObjectInstance[] = [];
            for (let dynObjInst of this.dynObjInsts) {
                if (this.selectedObject?.header.id0 == dynObjInst.objId0) {
                    dynObjs.push(dynObjInst);
                }
            }

            let dynObj = dynObjs[this.selectedObjectDynObjIndex];

            let t = this.editorDynObjAddrTransforms.get(dynObj.matrixAddress);
            if (!t) {
                this.editorDynObjAddrTransforms.set(dynObj.matrixAddress, mat4.create());
                t = this.editorDynObjAddrTransforms.get(dynObj.matrixAddress);
            }

            mat4.translate(t!, t!, translateVec!);
        }
    }
    public onGrabReleased(): void {
        console.log('grab released');
    }

    // Baking

    public bake() {
        const levelDataCopy = this.levelData.copyToBuffer();
        let s = new DataStream(new ArrayBufferSlice(levelDataCopy));

        console.log('bake');

        if (this.selectSeparateMeshes) {
            for (let object of this.objects) {
                for (let meshContainer of object.meshContainers) {
                    for (let mesh of meshContainer.meshes) {
                        for (let dirtyInstIndex of mesh.dirtyInstIndices) {
                            const addr = mesh.instanceAddressesAll[dirtyInstIndex];
                            const mat = mesh.instancesAll[dirtyInstIndex];

                            console.log('obj', object.header.name, 'cont', hexzero0x(meshContainer.offset),
                                'mesh', hexzero0x(mesh.offset), 'dirtyInstIndex', dirtyInstIndex, 'of', mesh.dirtyInstIndices.size,
                                'addr', hexzero0x(addr), 'mat', mat);

                            if (mesh.occlSpherePosAddr) {
                                s.offs = mesh.occlSpherePosAddr;
                                let v = s.readVec3();
                                if (addr == 1) {
                                    vec3.add(v, v, mesh.accumulatedTranslation);
                                } else {
                                    const translation = mat4.getTranslation(vec3.create(), mat);
                                    vec3.add(v, v, translation);
                                }
                                s.offs -= 3 * 4;
                                s.overwriteVec3(v);
                            }

                            if (addr == 0) {
                                // debugger;
                                // Not instanced, so change vertex data itself

                                console.log('addr==0, vtxDataAddrs:', mesh.vertexDataAddrs);
                                for (let j = 0; j < mesh.vertexDataAddrs.length; j++) {
                                    s.offs = mesh.vertexDataAddrs[j];

                                    for (let i = 0; i < mesh.vertexCounts[j]; ++i) {
                                        let v = s.readVec3();
                                        vec3.transformMat4(v, v, mat);
                                        s.offs -= 3 * 4;
                                        s.overwriteVec3(v);
                                        s.skip(0x24 - 0xC);
                                    }
                                }
                            } else if (addr == 1) {
                                // debugger;
                                // Not instanced, so change vertex data itself

                                console.log('addr==1, vtxDataAddrs:', mesh.vertexDataAddrs, 'counts', mesh.vertexCounts, 'add vec', mesh.accumulatedTranslation);
                                for (let j = 0; j < mesh.vertexDataAddrs.length; j++) {
                                    s.offs = mesh.vertexDataAddrs[j];

                                    for (let i = 0; i < mesh.vertexCounts[j]; ++i) {
                                        let v = s.readVec3();
                                        vec3.add(v, v, mesh.accumulatedTranslation);
                                        // vec3.transformMat4(v, v, mat);
                                        s.offs -= 3 * 4;
                                        s.overwriteVec3(v);
                                        s.skip(0x24 - 0xC);
                                    }
                                }
                            } else {
                                s.offs = addr;
                                s.overwriteMat4(mat);
                            }
                        }
                    }
                }
            }
        } else {
            console.log(this.editorDynObjAddrTransforms);
            for (let transform of this.editorDynObjAddrTransforms) {
                const addr = transform[0];
                const transformMat = transform[1];

                s.offs = addr;
                let mat = s.readMat4();
                mat4.mul(mat, mat, transformMat);
                s.offs -= 4 * 4 * 3;
                s.overwriteMat4(mat);
            }
        }
        downloadBuffer(this.levelFileName, levelDataCopy);
    }
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

    constructor(device: GfxDevice, cache: GfxRenderCache, meshChunk: MeshChunk, triangleIndices: Uint16Array) {
        const indices = Uint16Array.from(triangleIndices);
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
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.INDEX, triangleIndices.buffer);

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

    public isImageInline: boolean;

    private makeGfxTexture(device: GfxDevice, texture: Texture): GfxTexture {
        // console.log(`makeGfxTexture: size ${texture.width}x${texture.height}`);
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, texture.width, texture.height, 1));
        // console.log(gfxTexture);
        device.uploadTextureData(gfxTexture, 0, [texture.texelsRgba]);
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

    constructor(device: GfxDevice, gfxCache: GfxRenderCache, texture: Texture) {
        this.texture = this.makeGfxTexture(device, texture);
        this.sampler = this.makeGfxSampler(device, gfxCache);
        this.isImageInline = texture.isImageInline;
    }
}

const textureMappingScratch = nArray(2, () => new TextureMapping());

const viewMatScratch = mat4.create();
const modelViewMatScratch = mat4.create();
const modelViewMatScratch2 = mat4.create();

const DRAW_ALL_AABBS = false;

const worldRotX = mat4.fromXRotation(mat4.create(), 3 * 90 * MathConstants.DEG_TO_RAD);

export class EditorAABB extends AABB {
    constructor(
        minX: number = Infinity,
        minY: number = Infinity,
        minZ: number = Infinity,
        maxX: number = -Infinity,
        maxY: number = -Infinity,
        maxZ: number = -Infinity,
        public isDrawn = false, // TODO: remove?
        public isHuge = false
    ) {
        super(minX, minY, minZ, maxX, maxY, maxZ);
    }

    public clone(): EditorAABB {
        return new EditorAABB(this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ, this.isDrawn, this.isHuge);
    }
}

// TODO

export class Sly2MeshRenderer {
    public textureMatrix = mat4.create();

    private textureMappingDiffuse0: (TextureMapping | null);
    // private textureMappingDiffuse1: (TextureMapping | null);

    private megaStateFlags: Partial<GfxMegaStateDescriptor> = {};
    private isSkybox: boolean = false;

    public name: string
    public visible: boolean = true;
    public setVisible(v: boolean): void {
        this.visible = v;
    }

    public aabbOrigin: EditorAABB;
    public aabbs: EditorAABB[] = [];
    public aabbColor: Color;

    public drawAABBs = false;

    public levelEditorMatrices: mat4[] = [];

    constructor(
        private textureData: (TextureData | null)[],
        public geometryData: GeometryData,
        public meshChunk: MeshChunk,
        private isFullyOpaque: boolean,

        public meshInstanceMatrices0: mat4[],
        public meshInstanceMatrices1: mat4[],
        public meshInstanceTypes: MeshInstanceType[],

        public mesh: Mesh,
        public meshCont: MeshContainer,
        public object: LevelObject) {

        this.name = meshChunk.name;

        if (textureData[0]) {
            this.textureMappingDiffuse0 = new TextureMapping();
            this.textureMappingDiffuse0.gfxTexture = textureData[0].texture;
            this.textureMappingDiffuse0.gfxSampler = textureData[0].sampler;
            this.isSkybox = textureData[0].isImageInline;
        }
        // if (textureData[1]) {
        //     this.textureMappingDiffuse1 = new TextureMapping();
        //     this.textureMappingDiffuse1.gfxTexture = textureData[1].texture;
        //     this.textureMappingDiffuse1.gfxSampler = textureData[1].sampler;
        // }

        this.megaStateFlags.frontFace = GfxFrontFaceMode.CW;
        // this.megaStateFlags.cullMode = GfxCullMode.BACK;
        this.megaStateFlags.cullMode = GfxCullMode.NONE;

        setAttachmentStateSimple(this.megaStateFlags, {
            blendMode: GfxBlendMode.ADD,
            blendSrcFactor: GfxBlendFactor.SRC_ALPHA,
            blendDstFactor: GfxBlendFactor.ONE_MINUS_SRC_ALPHA,
        });

        this.aabbOrigin = new EditorAABB();
        this.aabbOrigin.setFromPointsFloatArray(meshChunk.positions);

        for (let i = 0; i < meshInstanceMatrices0.length; i++)
            this.levelEditorMatrices.push(mat4.create());

        this.calculateAABBs();
    }

    // public cloneDuplicate(): Sly2MeshRenderer {
    //     let dup = new Sly2MeshRenderer(this.textureData, this.geometryData, this.meshChunk, this.isFullyOpaque,
    //         this.meshInstanceMatrices0, this.meshInstanceMatrices1, this.meshInstanceTypes, this.mesh, this.meshCont, this.object);

    //     for (let i = 0; i < this.levelEditorMatrices.length; ++i) {
    //         // dup.levelEditorMatrices[i] = this.levelEditorMatrices[i];
    //         mat4.translate(dup.levelEditorMatrices[i], dup.levelEditorMatrices[i], vec3.fromValues(0, 1000, 0));
    //     }

    //     return dup;
    // }

    public addDuplicatedMatrix(idx: number) {
        this.meshInstanceMatrices0.push(mat4.copy(mat4.create(), this.meshInstanceMatrices0[idx]));
        this.meshInstanceMatrices1.push(mat4.copy(mat4.create(), this.meshInstanceMatrices1[idx]));
        this.levelEditorMatrices.push(mat4.copy(mat4.create(), this.levelEditorMatrices[idx]));
        this.meshInstanceTypes.push(this.meshInstanceTypes[idx]);
    }

    private getMatrix(idx: number): mat4 {
        // console.log('getMat', idx, this.levelEditorMatrices.length,this.meshInstanceMatrices0.length,this.meshInstanceMatrices1.length);
        // assert(this.levelEditorMatrices.length == this.meshInstanceMatrices0.length);
        // assert(this.meshInstanceMatrices0.length == this.meshInstanceMatrices1.length);
        return mat4.mul(
            mat4.create(),
            this.levelEditorMatrices[idx],
            mat4.mul(
                mat4.create(),
                this.meshInstanceMatrices0[idx],
                this.meshInstanceMatrices1[idx]
            )
        );
    }

    public calculateAABBs(): void {
        this.aabbs = [];

        // for (let meshInstanceMatrix of this.meshInstanceMatrices) {
        for (let i = 0; i < this.meshInstanceMatrices0.length; ++i) {
            let meshInstanceMatrix = this.getMatrix(i);
            let aabb = this.aabbOrigin.clone();

            mat4.copy(modelViewMatScratch2, worldRotX);
            mat4.mul(modelViewMatScratch2, modelViewMatScratch2, meshInstanceMatrix);
            aabb.transform(aabb, modelViewMatScratch2);

            this.aabbs.push(aabb);

            const extent = aabb.extents(vec3.create());
            aabb.isHuge = vec3.length(extent) > 10000;
        }

        const firstExtent = this.aabbs[0].extents(vec3.create());
        const pseudoRandomFloat = (vec3.length(firstExtent)) % 1;
        let randomColor = colorFromHSL(colorNewFromRGBA(0, 0, 0), pseudoRandomFloat, 0.5, 0.5, 0.3);
        this.aabbColor = randomColor;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplateRenderInst();

        template.setInputLayoutAndState(this.geometryData.inputLayout, this.geometryData.inputState);
        if (this.textureMappingDiffuse0) {
            // todo: is scratch/copy necessary? ask jasper
            textureMappingScratch[0].copy(this.textureMappingDiffuse0);
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

        // let texOffset = vec2.create();

        // if (!this.isSkybox)
        //     texOffset[1] = viewerInput.time / 10000.0;

        // TODO: instanced rendering

        for (let i = 0; i < this.meshInstanceMatrices0.length; ++i) {
            // const instanceMatrix = this.meshInstanceMatrices[i];
            const renderInstInstance = renderInstManager.newRenderInst();

            let offs = renderInstInstance.allocateUniformBuffer(SlyProgram.ub_ShapeParams, 4 * 4 /* + 2*/);
            const d = renderInstInstance.mapUniformBufferF32(SlyProgram.ub_ShapeParams);

            mat4.copy(modelViewMatScratch, viewMatScratch);

            mat4.mul(modelViewMatScratch, modelViewMatScratch, worldRotX);
            mat4.mul(modelViewMatScratch, modelViewMatScratch, this.getMatrix(i));
            // mat4.mul(modelViewMatScratch, modelViewMatScratch, this.levelEditorMatrices[i]);
            // mat4.mul(modelViewMatScratch, modelViewMatScratch, this.meshInstanceMatrices0[i]);
            // mat4.mul(modelViewMatScratch, modelViewMatScratch, this.meshInstanceMatrices1[i]);

            if (this.isSkybox)
                mat4.scale(modelViewMatScratch, modelViewMatScratch, [2, 2, 2]);

            offs += fillMatrix4x4(d, offs, modelViewMatScratch);
            // offs += fillVec2v(d, offs, texOffset);

            renderInstInstance.drawIndexes(this.geometryData.indexCount);
            renderInstManager.submitRenderInst(renderInstInstance);

            if (renderHacks.disableMeshInstances)
                break;
        }

        for (let aabb of this.aabbs) {
            if ((DRAW_ALL_AABBS || aabb.isDrawn || this.drawAABBs) && !aabb.isHuge) {
                drawWorldSpaceAABB(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, aabb, mat4.create(), this.aabbColor);
            }
        }

        renderInstManager.popTemplateRenderInst();
    }
}
