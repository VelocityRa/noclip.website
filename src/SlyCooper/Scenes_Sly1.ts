import ArrayBufferSlice from '../ArrayBufferSlice';
import { vec2, vec3 } from 'gl-matrix';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { GfxDevice, GfxRenderPass, GfxHostAccessPass, GfxBindingLayoutDescriptor, GfxProgram } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";
import { IS_DEVELOPMENT } from "../BuildVersion";
import { assert, hexzero, hexzero0x, leftPad } from '../util';
import { NamedArrayBufferSlice } from "../DataFetcher";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { range, range_end } from '../MathHelpers';
import { FakeTextureHolder } from '../TextureHolder';

const PARSE_MESHES = true;
const OBJ_EXPORT = true;

const PARSE_TEXTURES = false;
const TEXTURES_DOWNLOAD = false;
const TEXTURES_SORT_BY_SIZE = true;

// TODO: move out
function sprintf(fmt: string, ...args: any[]) {
    var i = -1;
    // @ts-ignore
    function callback(exp, p0, p1, p2, p3, p4) {
        if (exp == '%%') return '%';
        if (args[++i] === undefined) return undefined;
        exp = p2 ? parseInt(p2.substr(1)) : undefined;
        var base = p3 ? parseInt(p3.substr(1)) : undefined;
        var val;
        switch (p4) {
            case 's': val = args[i]; break;
            case 'c': val = args[i][0]; break;
            case 'f': val = parseFloat(args[i]).toFixed(exp); break;
            case 'p': val = parseFloat(args[i]).toPrecision(exp); break;
            case 'e': val = parseFloat(args[i]).toExponential(exp); break;
            case 'x': val = parseInt(args[i]).toString(base ? base : 16); break;
            case 'X': val = parseInt(args[i]).toString(base ? base : 16).toUpperCase(); break;
            case 'd': val = parseFloat(parseInt(args[i], base ? base : 10).toPrecision(exp)).toFixed(0); break;
        }
        val = typeof (val) == 'object' ? JSON.stringify(val) : val.toString(base);
        var sz = parseInt(p1); /* padding size */
        var ch = p1 && p1[0] == '0' ? '0' : ' '; /* isnull? */
        while (val.length < sz) val = p0 !== undefined ? val + ch : ch + val; /* isminus? */
        return val;
    }
    var regex = /%(-)?(0?[0-9]+)?([.][0-9]+)?([#][0-9]+)?([scfpexXd%])/g;
    return fmt.replace(regex, callback);
}


export class DataStream {
    constructor(
        public buffer: ArrayBufferSlice,
        public view: DataView = buffer.createDataView(),
        public offs: number = 0,
    ) {
    }

    public readUint8(): number { return this.view.getUint8(this.offs++); }
    public readUint16(): number { const v = this.view.getUint16(this.offs, true); this.offs += 0x02; return v; }
    public readUint32(): number { const v = this.view.getUint32(this.offs, true); this.offs += 0x04; return v; }
    public readFloat32(): number { const v = this.view.getFloat32(this.offs, true); this.offs += 0x04; return v; }
}

const pathBase = `Sly1`;

class SlyRenderer implements SceneGfx {
    public textureHolder = new FakeTextureHolder([]);

    constructor() {
    }

    public render(device: GfxDevice, renderInput: ViewerRenderInput): null {
        return null;
    }

    public destroy(device: GfxDevice): void {
    }
}

interface CLUTMetaEntry {
    colorCount: number;
    size: number;
    offset: number; // Relative to start of color palette data
}

function parseCLUTMetaEntries(stream: DataStream): CLUTMetaEntry[] {
    const entryCount = stream.readUint16();
    let entries = new Array<CLUTMetaEntry>();

    for (let i = 0; i < entryCount; ++i) {
        stream.offs += 4;
        const colorCount = stream.readUint16();
        const size = stream.readUint16();
        const offset = stream.readUint32();
        entries.push({ colorCount: colorCount, size: size, offset: offset });
    }

    return entries;
}

interface ImageMetaEntry {
    width: number;
    height: number;
    offset: number; // Relative to start of color palette data
}

function parseImageMetaEntries(stream: DataStream): ImageMetaEntry[] {
    const entryCount = stream.readUint16();
    let entries = new Array<ImageMetaEntry>();

    for (let i = 0; i < entryCount; ++i) {
        const width = stream.readUint16();
        const height = stream.readUint16();
        stream.offs += 12;
        const offset = stream.readUint32();
        entries.push({ width: width, height: height, offset: offset });
    }

    return entries;
}

interface TextureEntry {
    clutIndices: Uint16Array
    imageIndices: Uint16Array
}

function parseTextureEntries(stream: DataStream): TextureEntry[] {
    const entryCount = stream.readUint16();
    let entries = new Array<TextureEntry>();
    stream.offs += 0x18;

    for (let i = 0; i < entryCount; ++i) {
        stream.offs += 4;
        const imageCount = stream.readUint8();
        const clutCount = stream.readUint8();

        let imageIndices = new Uint16Array(imageCount);
        for (let i in range_end(0, imageCount)) {
            imageIndices[i] = stream.readUint16();
        }

        let clutIndices = new Uint16Array(clutCount);
        for (let i in range_end(0, clutCount)) {
            clutIndices[i] = stream.readUint16();
        }

        stream.offs += 0x14;
        let unk2 = stream.readUint16();
        if (unk2 > 0)
            stream.offs += 0x1C;

        entries.push({ clutIndices: clutIndices, imageIndices: imageIndices });
    }

    return entries;
}

function getCsm1ClutIndices(): Uint8Array {
    let tbl = new Uint8Array(256);
    for (let i of range_end(0, 0x100, 0x20)) {
        for (let j of range_end(i, i + 8)) {
            tbl[j] = j;
            tbl[j+8] = j+0x10;
            tbl[j+0x10] = j+0x8;
            tbl[j+0x18] = j+0x18;
        }
    }
    return tbl;
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class Texture {
    public texels_rgba: Uint8Array;
    public viewerTexture: Viewer.Texture[] = [];

    private static csm1ClutIndices = getCsm1ClutIndices();
    constructor(private paletteBuf: ArrayBufferSlice, private imageBuf: ArrayBufferSlice,
        public width: number, public height: number, public name: string = "N/A") {

        // TODO
        this.texels_rgba = new Uint8Array(width * height * 4);

        let texels_slice = imageBuf.createTypedArray(Uint8Array);
        let palette_slice = paletteBuf.createTypedArray(Uint8Array);

        for (let i of range_end(0, width * height)) {
            // const idx = texels_slice[i] * 4;
            const idx = Texture.csm1ClutIndices[texels_slice[i]] * 4;

            const x = i % width;
            const y = Math.floor(i / width);
            const inv_y = (-(y - (width / 2))) + width / 2 - 1;
            const offs = (inv_y * width + x) * 4;
            // const offs = i * 4;

            // const alpha = palette_slice[idx + 3] / 256; // Paint alpha black
            this.texels_rgba[offs + 0] = palette_slice[idx + 0];
            this.texels_rgba[offs + 1] = palette_slice[idx + 1];
            this.texels_rgba[offs + 2] = palette_slice[idx + 2];
            this.texels_rgba[offs + 3] = 0xFF; // palette_slice[idx + 3] * 2;
        }
    }

    public async toCanvas(): Promise<Viewer.Texture> {
        const canvas = document.createElement("canvas");
        const width = this.width;
        const height = this.height;
        canvas.width = width;
        canvas.height = height;
        canvas.title = this.name;

        // todo: flip here?

        const ctx = canvas.getContext("2d")!;
        const imgData = ctx.createImageData(canvas.width, canvas.height);
        imgData.data.set(this.texels_rgba);
        ctx.putImageData(imgData, 0, 0);
        const surfaces = [canvas];

        if (TEXTURES_DOWNLOAD) {
            downloadCanvasAsPng(canvas, this.name);
            await sleep(100); // todo test
        }

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', 'IDTEX8-CSM1 (PS2)');


        return { name: this.name, surfaces, extraInfo };
    }
}

interface MeshChunk {
    positions: Array<vec3>;
    normals: Array<vec3>;
    texCoords: Array<vec2>;
    unk_0x20: number;

    trianglesIndices: Array<vec3>;
    unkIndices: Uint16Array;
}

let totalChunkCount = 0;

class Mesh {
    static readonly szmsMagic = 0x534D5A53; // "SZMS"
    static readonly szmeMagic = 0x535A4D45; // "SZME"

    public chunks: MeshChunk[] = [];

    constructor(buffer: ArrayBufferSlice, public offset: number, public index: number) {
        const view = buffer.createDataView(offset);
        let stream = new DataStream(buffer, view);

        // Read data header

        assert(stream.readUint32() == Mesh.szmsMagic) // magic
        assert(stream.readUint32() == 0x4) // version

        const totalSize = stream.readUint32();

        const startOffs = stream.offs;

        // Read mesh header

        const unkMhdr0x00 = stream.readUint32();
        const unkMhdr0x04 = stream.readUint16();
        const meshCount = stream.readUint16();

        let meshOffsets: number[] = [];

        for (let i of range_end(0, meshCount)) {
            meshOffsets.push(stream.readUint32());
        }

        // console.log(sprintf('SZMS #%04d %05X %08X %s', index, totalSize, offset, meshOffsets));

        for (let meshOffs of meshOffsets) {
            stream.offs = startOffs + meshOffs;

            // Read vertices

            // Read vertex header

            const unkVtxHdr0x00 = stream.readUint32();
            const vertexCount = stream.readUint16();
            const unkVtxHdrCount = stream.readUint16();
            const vertexDataOffset = stream.readUint32();
            const indexHeaderOffset = stream.readUint32();

            const vertexDataSize = indexHeaderOffset - vertexDataOffset;

            stream.offs = startOffs + vertexDataOffset;

            // Read vertex data
            let positions = new Array<vec3>();
            let normals = new Array<vec3>();
            let texCoords = new Array<vec2>();
            let unk_0x20 = 0;

            let trianglesIndices = new Array<vec3>();
            let unkIndices: Uint16Array;

            for (let i = 0; i < vertexCount; ++i) {
                positions.push(vec3.fromValues(stream.readFloat32(), stream.readFloat32(), stream.readFloat32()));
                normals.push(vec3.fromValues(stream.readFloat32(), stream.readFloat32(), stream.readFloat32()));
                texCoords.push(vec2.fromValues(stream.readFloat32(), stream.readFloat32()));
                unk_0x20 = stream.readUint32();
            }

            stream.offs = startOffs + indexHeaderOffset;

            // Read index header

            const triangleCount = stream.readUint16();
            const indexCount = stream.readUint16();
            const indexDataOffs1 = stream.readUint32();
            const indexDataOffs2 = stream.readUint32();

            // Read index data

            // Read triangle data

            stream.offs = startOffs + indexDataOffs1;
            for (let i = 0; i < triangleCount; ++i) {
                trianglesIndices.push(vec3.fromValues(stream.readUint16(), stream.readUint16(), stream.readUint16()));
            }
            if (index == 0)
                console.log(trianglesIndices);

            // Read index data

            stream.offs = startOffs + indexDataOffs2;
            unkIndices = new Uint16Array(indexCount);

            for (let i of range_end(0, indexCount)) {
                unkIndices[i] = stream.readUint16();
            }

            this.chunks.push({ positions, normals, texCoords, unk_0x20, trianglesIndices, unkIndices });
            totalChunkCount++;
        }
    }
}

class Sly1LevelSceneDesc implements SceneDesc {
    private meshes: Mesh[] = [];
    private textures: Texture[] = [];

    constructor(public id: string, public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const renderer = new SlyRenderer();

        // TODO? Use compressed original files (orig. or zip/etc), or decompressed trimmed files

        const bin = await context.dataFetcher.fetchData(`${pathBase}/${this.id}_W.dec`)
        const binView = bin.createDataView();

        console.log(`loaded ${pathBase}/${this.id}_W.dec of size ${bin.byteLength}`);

        if (PARSE_TEXTURES) {
            // TODO: will we need to copy those?

            // this.textures.push(new Texture(bin.slice(0x93c640 ), bin.slice(0xA01100), 1024, 1024));
            // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400), bin.slice(0xA01100 + 0x100000), 1024, 1024));
            // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400*2), bin.slice(0xA01100 + 0x100000*2), 1024, 1024));
            // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400*3), bin.slice(0xA01100 + 0x100000*3), 1024, 1024));
            // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400*4), bin.slice(0xA01100 + 0x100000*4), 1024, 1024));

            // for (let i of range_end(200 * 0x400, 400 * 0x400, 0x400)) {
            // for (let i of range_end(319 * 0x400, 320 * 0x400, 0x400)) {
            //     this.textures.push(new Texture(
            //         bin.slice(0x93c640 + i), bin.slice(0xA01100 + 0x100000 * 2), 1024, 1024, (i / 0x400).toString()));
            // }

            // TODO: don't hardcode these
            const TEX_INFO_BASE = 0x4AFC;
            const TEX_PALETTE_BASE = 0x93c640;
            const TEX_IMAGE_BASE = 0xA01100;

            let textureInfoStream = new DataStream(bin.slice(TEX_INFO_BASE));

            const clutMetaEntries = parseCLUTMetaEntries(textureInfoStream);
            const imageMetaEntries = parseImageMetaEntries(textureInfoStream);
            const textureEntries = parseTextureEntries(textureInfoStream);

            console.log(clutMetaEntries);
            console.log(imageMetaEntries);
            console.log(textureEntries);

            let texEntryIdx = 0;
            for (let texEntry of textureEntries) {
                let makeTexture = (clutIndex: number, imageIndex: number) => {
                    if (clutIndex >= clutMetaEntries.length) {
                        console.log(`warn: clutIndex (${clutIndex}) out of bounds, skipping`);
                        return;
                    }
                    if (imageIndex >= imageMetaEntries.length) {
                        console.log(`warn: imageIndex (${imageIndex}) out of bounds, skipping`);
                        return;
                    }
                    let clutMeta = clutMetaEntries[clutIndex];
                    let imageMeta = imageMetaEntries[imageIndex];

                    if (clutMeta.colorCount == 256) {
                        const width = imageMeta.width;
                        const height = imageMeta.height;
                        // console.log(`clutMeta: ${clutMeta.offset} imageMeta: ${imageMeta.offset}`);
                        // console.log(`w: ${width} h: ${height} C: ${hexzero(clutMeta.offset, 8)} I: ${hexzero(imageMeta.offset, 8)}`);
                        const paletteBuf = bin.slice(TEX_PALETTE_BASE + clutMeta.offset);
                        const imageBuf = bin.slice(TEX_PALETTE_BASE + imageMeta.offset)
                        const name = sprintf('Id %03d-%03d-%03d Res %04dx%04d Clt %05X Img %06X',
                            texEntryIdx, clutIndex, imageIndex, width, height, clutMeta.offset, imageMeta.offset);
                        const texture = new Texture(paletteBuf, imageBuf, width, height, name);
                        this.textures.push(texture);
                    } else {
                        // todo
                        console.log(`skip, colorcount: ${clutMeta.colorCount}`);
                    }
                };

                const is1Img1Pal = (texEntry.clutIndices.length == texEntry.imageIndices.length);
                const is1ImgManyPal = (texEntry.imageIndices.length == 1) && (texEntry.clutIndices.length > 1);
                const isManyImgManyPal = !is1Img1Pal && (texEntry.imageIndices.length > 1) && (texEntry.clutIndices.length > 1);

                if (is1Img1Pal) {
                    for (let i = 0; i < texEntry.clutIndices.length; i++) {
                        makeTexture(texEntry.clutIndices[i], texEntry.imageIndices[i]);
                    }
                } else if (is1ImgManyPal) {
                    for (let palIndex of texEntry.clutIndices) {
                        makeTexture(palIndex, texEntry.imageIndices[0]);
                    }
                } else if (isManyImgManyPal) {
                    if (!Number.isInteger(texEntry.clutIndices.length / texEntry.imageIndices.length)) {
                        console.log(`WARN: nonint m2m ${texEntryIdx} ${texEntry.clutIndices.length} ${texEntry.imageIndices.length}`);
                    }
                    const divPalImg = Math.floor(texEntry.clutIndices.length / texEntry.imageIndices.length);
                    for (let i = 0; i < texEntry.clutIndices.length; ++i) {
                        let imgIndex = Math.floor(i / divPalImg);
                        makeTexture(texEntry.clutIndices[i], texEntry.imageIndices[imgIndex]);
                    }
                } else {
                    console.log(`WARN: other ${texEntryIdx} ${texEntry.clutIndices.length} ${texEntry.imageIndices.length}`);
                }
                texEntryIdx++;
            }

            if (TEXTURES_SORT_BY_SIZE) {
                this.textures.sort((texA: Texture, texB: Texture) => (texA.width * texA.height > texB.width * texB.height) ? -1 : 1);
            }

            for (let tex of this.textures) {
                renderer.textureHolder.viewerTextures.push(await tex.toCanvas());
            }
        }

        if (PARSE_MESHES) {
            let index = 0;
            for (let offset = 0; offset < bin.byteLength - 4; ++offset) {
                if (binView.getUint32(offset, true) === Mesh.szmsMagic) {
                    this.meshes.push(new Mesh(bin, offset, index));
                    ++index;
                }
            }

            console.log(`Total chunk count ${totalChunkCount}`);

            // export to .obj

            if (OBJ_EXPORT) {
                let obj_str = "";

                let face_idx_base = 1;

                let mesh_idx = 0;
                let chunk_total_idx = 0;
                for (let mesh of this.meshes) {
                    // obj_str += `o ${mesh.index}_${hexzero0x(mesh.offset)}\n`;

                    let chunk_idx = 0;
                    for (let chunk of mesh.chunks) {
                        // obj_str += `g ${mesh.index}_${hexzero0x(mesh.offset)}_${chunk_idx}\n`;
                        obj_str += `o ${mesh_idx}-${chunk_idx}_${chunk_total_idx}_${hexzero0x(mesh.offset)}\n`;

                        for (let pos of chunk.positions) {
                            let scaled_pos = vec3.create();
                            vec3.scale(scaled_pos, pos, 1 / 1000.0);

                            obj_str += `v ${scaled_pos[0]} ${scaled_pos[1]} ${scaled_pos[2]}\n`;
                        }

                        for (let normal of chunk.normals) {
                            obj_str += `vn ${normal[0]} ${normal[1]} ${normal[2]}\n`;
                        }

                        for (let texCoord of chunk.texCoords) {
                            obj_str += `vt ${texCoord[0]} ${texCoord[1]}\n`;
                        }

                        obj_str += `s off\n`;
                        for (let i of chunk.trianglesIndices) {
                            const f0 = face_idx_base + i[0];
                            const f1 = face_idx_base + i[1];
                            const f2 = face_idx_base + i[2];

                            obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
                        }
                        face_idx_base += chunk.positions.length;

                        chunk_idx++;
                        chunk_total_idx++;
                    }
                    chunk_idx = 0;
                    mesh_idx++;
                }

                downloadText(`${this.id}.obj`, obj_str);
            }
        }

        return renderer;
    }
}

// From https://docs.google.com/spreadsheets/d/1bdhTl2IvXVWOjnjhpgUTH0kg6e-RcioezIYrsi-_mso/edit#gid=0
// TODO: Should titles be world titles instead of ep?
const sceneDescs = [
    "Police Headquarters (Paris, France)",
    new Sly1LevelSceneDesc("jb_intro", "Paris, France"),

    "Tide of Terror (Isle of Wrath, Wales)",
    new Sly1LevelSceneDesc("uw_exterior_approach", "A Stealthy Approach"),
    new Sly1LevelSceneDesc("uw_exterior_boat", "Prowling the Grounds"),
    new Sly1LevelSceneDesc("uw_bonus_drivewheels", "Into the Machine"),
    new Sly1LevelSceneDesc("uw_bonus_security", "High Class Heist"),
    new Sly1LevelSceneDesc("uw_c2_final", "The Fire Down Below"),
    new Sly1LevelSceneDesc("uw_bonus_library", "A Cunning Disguise"),
    new Sly1LevelSceneDesc("uw_t3_final", "Gunboat Graveyard"),
    new Sly1LevelSceneDesc("uw_rip_off", "Treasure in the Depths"),
    new Sly1LevelSceneDesc("uw_boss_blimp", "The Eye of the Storm"),

    "Sunset Snake Eyes (Mesa City, Utah)",
    new Sly1LevelSceneDesc("ms_approach", "A Rocky Start"),
    new Sly1LevelSceneDesc("ms_exterior", "Muggshot's Turf"),
    new Sly1LevelSceneDesc("ms_casino", "Boneyard Casino"),
    new Sly1LevelSceneDesc("ms_sniper", "Murray's Big Gamble"),
    new Sly1LevelSceneDesc("ms_suv", "At the Dog Track"),
    new Sly1LevelSceneDesc("ms_inspector", "Two to Tango"),
    new Sly1LevelSceneDesc("ms_vertigo", "Back Alley Heist"),
    new Sly1LevelSceneDesc("ms_rooftop", "Straight to the Top"),
    new Sly1LevelSceneDesc("ms_boss_battle", "Last Call"),

    "Vicious Voodoo (Haiti)",
    new Sly1LevelSceneDesc("v_approach", "The Dread Swamp Path"),
    new Sly1LevelSceneDesc("v_hub", "The Swamp's Dark Center"),
    new Sly1LevelSceneDesc("v_swamp_monster", "The Lair of the Beast"),
    new Sly1LevelSceneDesc("v_gomerville", "A Grave Undertaking"),
    new Sly1LevelSceneDesc("v_puffer", "Piranha Lake"),
    new Sly1LevelSceneDesc("v_skinterior", "Descent Into Danger"),
    new Sly1LevelSceneDesc("v_murray", "A Ghastly Voyage"),
    new Sly1LevelSceneDesc("v_chicken", "Down Home Cooking"),
    new Sly1LevelSceneDesc("v_boss", "A Deadly Dance"),

    "Fire in the Sky (Kunlun Mountains, China)",
    new Sly1LevelSceneDesc("s_approach", "A Perilous Ascent"),
    new Sly1LevelSceneDesc("s_hub", "Inside the Stronghold"),
    new Sly1LevelSceneDesc("s_security", "Flaming Temple of Flame"),
    new Sly1LevelSceneDesc("s_barrel", "The Unseen Foe"),
    new Sly1LevelSceneDesc("s_sniper", "The King of the Hill"),
    new Sly1LevelSceneDesc("s_tank", "Rapid Fire Assault"),
    new Sly1LevelSceneDesc("s_suv", "A Desperate Race"),
    new Sly1LevelSceneDesc("s_inspector", "Duel by the Dragon"),
    new Sly1LevelSceneDesc("s_boss", "Flame Fu!"),

    "The Cold Heart of Hate (Krakarov Volcano, Russia)",
    new Sly1LevelSceneDesc("cw_turret", "A Hazardous Path"),
    new Sly1LevelSceneDesc("cw_suv", "Burning Rubber"),
    new Sly1LevelSceneDesc("cw_security", "A Daring Rescue"),
    new Sly1LevelSceneDesc("cw_bentley", "Bentley Comes Through"),
    new Sly1LevelSceneDesc("cw_reverse_sniper", "A Temporary Truce"),
    new Sly1LevelSceneDesc("cw_outclimb", "Sinking Peril"),
    new Sly1LevelSceneDesc("cw_finish", "A Strange Reunion"),

    "Miscellaneous",
    new Sly1LevelSceneDesc("splash", "Splash"),
    new Sly1LevelSceneDesc("hideout", "The Hideout")
];

const id = 'Sly1';
const name = 'Sly Cooper and the Thievius Raccoonus';
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
