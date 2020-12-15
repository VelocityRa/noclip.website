
import ArrayBufferSlice from "../ArrayBufferSlice";
import { assert, nArray } from "../util";
import { GfxDevice, GfxTexture, GfxTextureDimension, GfxFormat, GfxBufferUsage, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency, GfxIndexBufferDescriptor } from "../gfx/platform/GfxPlatform";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { Color } from "../Color";
import { _T, GfxBuffer, GfxInputLayout, GfxInputState } from "../gfx/platform/GfxPlatformImpl";
import { AABB } from "../Geometry";
import { vec3, vec2, vec4 } from "gl-matrix";
import { makeStaticDataBufferFromSlice } from "../gfx/helpers/BufferHelpers";
import { getFormatByteSize } from "../gfx/platform/GfxPlatformFormat";
import { Destroyable } from "../SceneBase";
import { GfxRenderInst } from "../gfx/render/GfxRenderer";
import { TextureMapping } from "../TextureHolder";
