
import { NamedArrayBufferSlice } from "../DataFetcher";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { SceneGfx } from "../viewer";
import { parseMESHWORLD } from "./bin";
import { Scene } from "./render";

const pathBase = `Hamsterball`;

export class HambsterballSceneDesc implements SceneDesc {
    constructor(public id: string, public name: string = id) {
    }

    public async createScene(device: GfxDevice, sceneContext: SceneContext): Promise<SceneGfx> {
        const meshworld = parseMESHWORLD(await sceneContext.dataFetcher.fetchData(`${pathBase}/Levels/${this.id}.MESHWORLD`));
        // const meshworld = parseCACHED(await sceneContext.dataFetcher.fetchData(`${pathBase}/Levels/${this.id.toLowerCase()}.cached`));

        let obj_str = "";
        // obj_str += `mtllib ${this.id}.mtl\n`;

        obj_str += `g all\n`;
        obj_str += `s off\n`;

        const vertexCount = meshworld.vertexData.positions.length / 3;
        for (let i = 0; i < vertexCount; ++i) {
            const px = meshworld.vertexData.positions[i * 3 + 0];
            const py = meshworld.vertexData.positions[i * 3 + 1];
            const pz = meshworld.vertexData.positions[i * 3 + 2];

            obj_str += `v ${px} ${py} ${pz}\n`;

            const pnx = meshworld.vertexData.normals[i * 3 + 0];
            const pny = meshworld.vertexData.normals[i * 3 + 1];
            const pnz = meshworld.vertexData.normals[i * 3 + 2];

            obj_str += `vn ${pnx} ${pny} ${pnz}\n`;

            const ptu = meshworld.vertexData.texcoords[i * 2 + 0];
            const ptv = meshworld.vertexData.texcoords[i * 2 + 1];

            obj_str += `vt ${ptu} ${ptv}\n`;
        }

        const indexCount = meshworld.indexData.length;
        for (let i = 0; i < indexCount / 3; ++i) {
            const f0 = meshworld.indexData[i * 3 + 0] + 1;
            const f1 = meshworld.indexData[i * 3 + 1] + 1;
            const f2 = meshworld.indexData[i * 3 + 2] + 1;

            obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
        }

        // const triangleCount = vertexCount / 3 - 3;
        // for (let i = 0; i < triangleCount; ++i) {
        //     const f0 = i * 3 + 1;
        //     const f1 = i * 3 + 2;
        //     const f2 = i * 3 + 3;

        //     obj_str += `f ${f0}//${f0} ${f1}//${f1} ${f2}//${f2}\n`;
        // }

        // const triangleCount = vertexCount / 3 - 2 - 1;
        // for (let i = 0; i < triangleCount; ++i) {
        //     const f0 = i + 1;
        //     const f1 = i + 2;
        //     const f2 = i + 3;

        //     obj_str += `f ${f0}//${f0} ${f1}//${f1} ${f2}//${f2}\n`;
        // }

        // const quadCount = vertexCount / 4 - 4;
        // for (let i = 0; i < quadCount; ++i) {
        //     const f0 = i * 4 + 1;
        //     const f1 = i * 4 + 2;
        //     const f2 = i * 4 + 3;
        //     const f3 = i * 4 + 4;

        //     obj_str += `f ${f0}//${f0} ${f1}//${f1} ${f2}//${f2} ${f3}//${f3}\n`;
        // }

        downloadText(`${this.id}.obj`, obj_str);

        return new Scene(device, meshworld);
    }
}

const sceneDescs = [
    new HambsterballSceneDesc('Level1'),
];

const id = 'Hambsterball';
const name = "Hambsterball";
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
