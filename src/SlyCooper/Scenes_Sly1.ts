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
import { SlyRenderer } from './SlyRenderer';
import * as Settings from './SlyConstants';
import * as Data from './SlyData';

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

const pathBase = `Sly1`;

class Sly1LevelSceneDesc implements SceneDesc {
    private meshes: Data.Mesh[] = [];
    private textures: Data.Texture[] = [];

    constructor(public id: string, public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {

        // TODO? Use compressed original files (orig. or zip/etc), or decompressed trimmed files

        const bin = await context.dataFetcher.fetchData(`${pathBase}/${this.id}_W.dec`)
        const binView = bin.createDataView();

        console.log(`loaded ${pathBase}/${this.id}_W.dec of size ${bin.byteLength}`);

        if (Settings.PARSE_TEXTURES) {
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
            // const TEX_IMAGE_BASE = 0xA01100;

            let textureInfoStream = new Data.DataStream(bin.slice(TEX_INFO_BASE));

            const clutMetaEntries = Data.parseCLUTMetaEntries(textureInfoStream);
            const imageMetaEntries = Data.parseImageMetaEntries(textureInfoStream);
            const textureEntries = Data.parseTextureEntries(textureInfoStream);

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
                        const texture = new Data.Texture(paletteBuf, imageBuf, width, height, name);
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

            if (Settings.TEXTURES_SORT_BY_SIZE) {
                this.textures.sort((texA: Data.Texture, texB: Data.Texture) => (texA.width * texA.height > texB.width * texB.height) ? -1 : 1);
            }

        }

        if (Settings.PARSE_MESHES) {
            let index = 0;
            for (let offset = 0; offset < bin.byteLength - 4; ++offset) {
                if (binView.getUint32(offset, true) === Data.Mesh.szmsMagic) {
                    this.meshes.push(new Data.Mesh(bin, offset, index));
                    ++index;
                }
            }

            console.log(`Total chunk count ${Data.totalChunkCount}`);

            // export to .obj

            if (Settings.MESH_EXPORT) {
                let obj_str = "";

                let face_idx_base = 1;

                let mesh_idx = 0;
                let chunk_total_idx = 0;
                for (let mesh of this.meshes) {
                    if (!Settings.SEPARATE_OBJECT_SUBMESHES) {
                        obj_str += `o ${mesh.index}_${hexzero0x(mesh.offset)}\n`;
                    }

                    let chunk_idx = 0;
                    for (let chunk of mesh.chunks) {
                        if (Settings.SEPARATE_OBJECT_SUBMESHES) {
                            obj_str += `o ${mesh_idx}-${chunk_idx}_${chunk_total_idx}_${hexzero0x(mesh.offset)}\n`;
                        } else {
                            obj_str += `g ${mesh.index}_${hexzero0x(mesh.offset)}_${chunk_idx}\n`;
                        }

                        for (let i = 0; i < chunk.positions.length; i += 3) {
                            let scaled_pos = vec3.fromValues(
                                chunk.positions[i] * Settings.MESH_SCALE,
                                chunk.positions[i + 1] * Settings.MESH_SCALE,
                                chunk.positions[i + 2] * Settings.MESH_SCALE);

                            obj_str += `v ${scaled_pos[0]} ${scaled_pos[1]} ${scaled_pos[2]}\n`;
                        }

                        for (let i = 0; i < chunk.normals.length; i += 3) {
                            let normal = vec3.fromValues(chunk.normals[i], chunk.normals[i + 1], chunk.normals[i + 2]);

                            obj_str += `vn ${normal[0]} ${normal[1]} ${normal[2]}\n`;
                        }

                        for (let i = 0; i < chunk.texCoords.length; i += 2) {
                            let texCoord = vec2.fromValues(chunk.texCoords[i], chunk.texCoords[i + 1]);

                            obj_str += `vt ${texCoord[0]} ${texCoord[1]}\n`;
                        }

                        obj_str += `s off\n`;
                        for (let i = 0; i < chunk.trianglesIndices.length; i += 3) {
                            const f0 = face_idx_base + chunk.trianglesIndices[i + 0];
                            const f1 = face_idx_base + chunk.trianglesIndices[i + 1];
                            const f2 = face_idx_base + chunk.trianglesIndices[i + 2];

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

        const renderer = new SlyRenderer(device, this.meshes, this.textures);

        for (let tex of this.textures) {
            renderer.textureHolder.viewerTextures.push(await tex.toCanvas());
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
